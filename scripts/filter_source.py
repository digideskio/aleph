#!/usr/bin/env python

import re
import sys
import argparse
import gzip

parser = argparse.ArgumentParser()
parser.add_argument('dump_filename')
parser.add_argument('output_prefix')
parser.add_argument('--lines', help='lines per output file.',
                    type=int, default=1000)
parser.add_argument('--tsv', help='if true, input is tab-separated, and json value is second field',
                    action='store_true')

args = parser.parse_args()

states = {}
p = re.compile('"source_dataset":\s+"(.*?)"')

numeric_suffix_digits = 10

def close_outfile(state):
    if 'gzip_file' in state and not state['gzip_file'].closed:
        state['gzip_file'].close()

def open_outfile(state):
    close_outfile(state)
    suffix = str(state['file_number']).zfill(numeric_suffix_digits)

    filename = '{prefix}_{dataset}_{suffix}.json.gz'.format(
      prefix=args.output_prefix,
      dataset=state['dataset'],
      suffix=suffix
    )
    state['gzip_file'] = gzip.open(filename, 'w')

with open(args.dump_filename) as f:
  for line in f:
    if args.tsv:
        line = line.split('\t')[1]

    m = p.search(line)
    if m is None:
      print('no match for line: ', line)
      continue

    dataset = m.group(1)
    state = states.get(dataset, None)
    if state is None:
      state = {'dataset': dataset, 'file_number': 1, 'counter': 0}
      open_outfile(state)
      states[dataset] = state

    if state['counter'] >= args.lines:
        state['file_number'] = state['file_number'] + 1
        state['counter'] = 0
        open_outfile(state)

    state['counter'] = state['counter'] + 1
    state['gzip_file'].write(line)

for dataset, state in states.iteritems():
  print('closing file for {}'.format(dataset))
  close_outfile(state)
