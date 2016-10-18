#!/usr/bin/env python

import os
import argparse
import hashlib

parser = argparse.ArgumentParser()
parser.add_argument('--bucket', help='s3 bucket to store files in', required=True)
parser.add_argument('--manifest', help='filename to write manifest to', default='./s3-manifest.txt')
parser.add_argument('filenames', help='filenames to store in s3', nargs='*')

args = parser.parse_args()

def string_sha1(s):
    h = hashlib.sha1()
    h.update(s)
    return h.hexdigest()

BLOCKSIZE = 65536
def file_sha1(filename):
    h = hashlib.sha1()
    with open(filename, 'rb') as f:
        buf = f.read(BLOCKSIZE)
        while len(buf) > 0:
            h.update(buf)
            buf = f.read(BLOCKSIZE)
    return h.hexdigest()

for fn in args.filenames:
    if not os.path.isfile(fn):
        print('file "{}" does not exist, ignoring'.format(fn))
        continue

    basename = os.path.basename(fn)
    name_hash = string_sha1(basename)
    prefix = name_hash[:4]
    content_hash = file_sha1(fn)

    s3_key = '/'.join([prefix, basename])
    manifest_entry = '\t'.join([s3_key, content_hash])
    print(manifest_entry)

    # TODO: do the thing!
