#!/usr/bin/env python3
"""Patch only the two audited app identity properties in pinned source."""
import argparse,hashlib,pathlib,re,sys
PINNED='238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725'
def fail(s): print('ERROR:'+s,file=sys.stderr); raise SystemExit(2)
def replace(data,old,new,label):
 if data.count(old)!=1: fail(f'EXPECTED_ONE_{label}_ASSIGNMENT_FOUND_{data.count(old)}')
 return data.replace(old,new,1)
p=argparse.ArgumentParser();p.add_argument('properties',type=pathlib.Path);p.add_argument('--data-dir',required=True);p.add_argument('--prefix',required=True);a=p.parse_args()
data_dir=a.data_dir.rstrip('/');prefix=a.prefix.rstrip('/')
if not re.fullmatch(r'/data/(?:data|user/0)/com\.karat\.aibuilder',data_dir): fail('APP_DATA_DIR_NOT_CANONICAL')
if prefix!=data_dir+'/files/usr': fail('PREFIX_MISMATCH')
path=a.properties; original=path.read_bytes(); actual=hashlib.sha256(original).hexdigest()
if actual!=PINNED: fail('UPSTREAM_PROPERTIES_HASH_MISMATCH_'+actual)
patched=replace(original,b'TERMUX_APP__PACKAGE_NAME="com.termux"',b'TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"','APP_ID')
patched=replace(patched,b'TERMUX_APP__DATA_DIR="/data/data/$TERMUX_APP__PACKAGE_NAME"',f'TERMUX_APP__DATA_DIR="{data_dir}"'.encode(),'APP_DATA_DIR')
path.write_bytes(patched); print('AIB_PROPERTIES_PATCH_OK app=com.karat.aibuilder fields=2')
