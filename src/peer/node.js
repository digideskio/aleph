const P2PNode = require('./libp2p_node')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const Multiaddr = require('multiaddr')
const Multihash = require('multihashes')
const pb = require('../protobuf')
const pull = require('pull-stream')
const paramap = require('pull-paramap')
const { DEFAULT_LISTEN_ADDR, PROTOCOLS } = require('./constants')
const { inflateMultiaddr } = require('./identity')
const {
  protoStreamEncode,
  protoStreamDecode,
  peerInfoProtoMarshal,
  lookupResponseToPeerInfo,
  pullToPromise,
  pullRepeatedly,
  resultStreamThrough,
  objectIdsForQueryResult,
  expandQueryResult
} = require('./util')

import type { QueryResultMsg, QueryResultValueMsg, DataResultMsg, DataObjectMsg, NodeInfoMsg } from '../protobuf/types'
import type { Connection } from 'interface-connection'
import type { PullStreamSource } from './util'

export type MediachainNodeOptions = {
  peerId: PeerId,
  dirInfo?: PeerInfo,
  listenAddresses?: Array<Multiaddr | string>,
  infoMessage?: string
}

const DEFAULT_INFO_MESSAGE = '(aleph)'

class MediachainNode {
  p2p: P2PNode
  directory: ?PeerInfo
  infoMessage: string

  constructor (options: MediachainNodeOptions) {
    let {peerId, dirInfo, listenAddresses} = options
    if (listenAddresses == null) listenAddresses = [DEFAULT_LISTEN_ADDR]

    const peerInfo = new PeerInfo(peerId)
    listenAddresses.forEach((addr: Multiaddr | string) => {
      peerInfo.multiaddr.add(Multiaddr(addr))
    })

    this.infoMessage = options.infoMessage || DEFAULT_INFO_MESSAGE

    this.p2p = new P2PNode({peerInfo})
    this.directory = dirInfo
    this.p2p.handle(PROTOCOLS.node.ping, this.pingHandler.bind(this))
    this.p2p.handle(PROTOCOLS.node.id, this.idHandler.bind(this))
  }

  start (): Promise<void> {
    return this.p2p.start()
  }

  stop (): Promise<void> {
    return this.p2p.stop()
  }

  get peerInfo (): PeerInfo {
    return this.p2p.peerInfo
  }

  setDirectory (dirInfo: PeerInfo | string) {
    if (typeof dirInfo === 'string') {
      dirInfo = inflateMultiaddr(dirInfo)
    }
    this.directory = dirInfo
  }

  setInfoMessage (message: string) {
    this.infoMessage = message
  }

  register (): Promise<boolean> {
    if (this.directory == null) {
      return Promise.reject(new Error('No known directory server, cannot register'))
    }

    const abortable = this.p2p.newAbortable()

    const req = {
      info: peerInfoProtoMarshal(this.p2p.peerInfo)
    }

    return this.p2p.dialByPeerInfo(this.directory, PROTOCOLS.dir.register)
      .then(conn => {
        pull(
          pullRepeatedly(req, 5000 * 60),
          abortable,
          protoStreamEncode(pb.dir.RegisterPeer),
          conn,
          pull.onEnd(() => {
            console.log('registration connection ended')
          })
        )
        return true
      })
  }

  lookup (peerId: string | PeerId): Promise<?PeerInfo> {
    if (peerId instanceof PeerId) {
      peerId = peerId.toB58String()
    } else {
      // validate that string arguments are legit multihashes
      try {
        Multihash.fromB58String(peerId)
      } catch (err) {
        return Promise.reject(new Error(`Peer id is not a valid multihash: ${err.message}`))
      }
    }

    // If we've already got an entry for this PeerId in our PeerBook,
    // because we already have a multiplex connection open to this peer,
    // use the existing entry.
    //
    // Note that when we close the peer multiplex connection, then entry is
    // automatically removed from the peer book, so we should never be returning
    // stale results.
    try {
      const peerInfo = this.p2p.peerBook.getByB58String(peerId)
      return Promise.resolve(peerInfo)
    } catch (err) {
    }

    if (this.directory == null) {
      return Promise.reject(new Error('No known directory server, cannot lookup'))
    }

    return this.p2p.dialByPeerInfo(this.directory, PROTOCOLS.dir.lookup)
      .then(conn => pullToPromise(
        pull.values([{id: peerId}]),
        protoStreamEncode(pb.dir.LookupPeerRequest),
        conn,
        protoStreamDecode(pb.dir.LookupPeerResponse),
        pull.map(lookupResponseToPeerInfo),
        )
      )
  }

  _lookupIfNeeded (peer: PeerInfo | PeerId | string): Promise<?PeerInfo> {
    if (peer instanceof PeerInfo) {
      return Promise.resolve(peer)
    }
    if (typeof peer === 'string' && peer.startsWith('/')) {
      // try to decode as multiaddr. If it doesn't start with '/', it may be resolvable
      // as a multihash peer id via lookup()
      try {
        const peerInfo = inflateMultiaddr(peer)
        return Promise.resolve(peerInfo)
      } catch (err) {
        return Promise.reject(new Error(`Peer id is not a valid multiaddr: ${err.message}`))
      }
    }

    return this.lookup(peer)
  }

  openConnection (peer: PeerInfo | PeerId | string, protocol: string): Promise<Connection> {
    return this._lookupIfNeeded(peer)
      .then(maybePeer => {
        if (!maybePeer) throw new Error(`Unable to locate peer ${peer}`)
        return maybePeer
      })
      .then(peerInfo => this.p2p.dialByPeerInfo(peerInfo, protocol))
  }

  ping (peer: PeerInfo | PeerId | string): Promise<boolean> {
    return this.openConnection(peer, PROTOCOLS.node.ping)
      .then((conn: Connection) => pullToPromise(
        pull.values([{}]),
        protoStreamEncode(pb.node.Ping),
        conn,
        protoStreamDecode(pb.node.Pong),
        pull.map(_ => { return true })
      ))
  }

  pingHandler (protocol: string, conn: Connection) {
    pull(
      conn,
      protoStreamDecode(pb.node.Ping),
      protoStreamEncode(pb.node.Pong),
      conn
    )
  }

  idHandler (protocol: string, conn: Connection) {
    const response = {
      peer: this.peerInfo.id.toB58String(),
      info: this.infoMessage
    }

    pull(
      conn,
      protoStreamDecode(pb.node.NodeInfoRequest),
      pull.map(() => response),
      protoStreamEncode(pb.node.NodeInfo),
      conn
    )
  }

  remoteNodeInfo (peer: PeerInfo | PeerId | string): Promise<NodeInfoMsg> {
    return this.openConnection(peer, PROTOCOLS.node.id)
      .then(conn => pullToPromise(
        pull.once({}),
        protoStreamEncode(pb.node.NodeInfoRequest),
        conn,
        protoStreamDecode(pb.node.NodeInfo)
      ))
  }

  remoteQueryStream (peer: PeerInfo | PeerId | string, queryString: string): Promise<PullStreamSource> {
    return this.openConnection(peer, PROTOCOLS.node.query)
      .then(conn => pull(
          pull.values([{query: queryString}]),
          protoStreamEncode(pb.node.QueryRequest),
          conn,
          protoStreamDecode(pb.node.QueryResult),
          resultStreamThrough,
        ))
  }

  remoteQuery (peer: PeerInfo | PeerId | string, queryString: string): Promise<Array<QueryResultMsg>> {
    return this.remoteQueryStream(peer, queryString)
      .then(stream => new Promise((resolve, reject) => {
        pull(
          stream,
          pull.collect((err, results) => {
            if (err) return reject(err)
            resolve(results)
          })
        )
      }))
  }

  remoteData (peer: PeerInfo | PeerId | string, keys: Array<string>): Array<DataResultMsg> {
    return this.remoteDataStream(peer, keys)
      .then(stream => new Promise((resolve, reject) => {
        pull(
          stream,
          pull.collect((err, results) => {
            if (err) return reject(err)
            resolve(results)
          })
        )
      }))
  }

  remoteDataStream (peer: PeerInfo | PeerId | string, keys: Array<string>): Promise<PullStreamSource> {
    return this.openConnection(peer, PROTOCOLS.node.data)
      .then(conn => pull(
        pull.once({keys}),
        protoStreamEncode(pb.node.DataRequest),
        conn,
        protoStreamDecode(pb.node.DataResult),
        resultStreamThrough,
        pull.map(result => result.data)
      ))
  }

  // local queries (NOT IMPLEMENTED -- NO LOCAL STORE)
  query (queryString: string): Promise<Array<QueryResultMsg>> {
    throw new Error('Local statement db not implemented!')
  }

  data (keys: Array<string>): Array<DataResultMsg> {
    throw new Error('Local datastore not implemented!')
  }

  remoteQueryWithDataStream (peer: PeerInfo | PeerId | string, queryString: string): Promise<PullStreamSource> {
    return this.remoteQueryStream(peer, queryString)
      .then(resultStream =>
        pull(
          resultStream,
          paramap((queryResult, cb) => {
            if (queryResult.value == null) {
              return cb(null, queryResult)
            }

            this._expandQueryResultData(peer, queryResult.value)
              .then(result => cb(null, result))
              .catch(err => cb(err))
          })
        )
      )
  }

  remoteQueryWithData (peer: PeerInfo | PeerId | string, queryString: string): Promise<Array<Object>> {
    return this.remoteQueryWithDataStream(peer, queryString)
      .then(stream => new Promise((resolve, reject) => {
        pull(
          stream,
          pull.collect((err, results) => {
            if (err) return reject(err)
            resolve(results)
          })
        )
      }))
  }

  _expandQueryResultData (peer: PeerInfo | PeerId | string, result: QueryResultValueMsg): Promise<Object> {
    const objectIds = objectIdsForQueryResult(result)
    if (objectIds.length < 1) return Promise.resolve(result)

    return this.remoteData(peer, objectIds)
      .then((dataResults: Array<DataObjectMsg>) =>
        expandQueryResult(result, dataResults)
      )
  }
}

class RemoteNode {
  node: MediachainNode
  remotePeerInfo: PeerInfo

  constructor (node: MediachainNode, remotePeerInfo: PeerInfo) {
    this.node = node
    this.remotePeerInfo = remotePeerInfo
  }

  ping (): Promise<boolean> {
    return this.node.ping(this.remotePeerInfo)
  }

  query (queryString: string): Promise<Array<QueryResultMsg>> {
    return this.node.remoteQuery(this.remotePeerInfo, queryString)
  }

  data (keys: Array<string>): Array<DataResultMsg> {
    return this.node.remoteData(this.remotePeerInfo, keys)
  }

  queryWithData (queryString: string): Promise<Array<Object>> {
    return this.node.remoteQueryWithData(this.remotePeerInfo, queryString)
  }
}

module.exports = {
  MediachainNode,
  RemoteNode
}
