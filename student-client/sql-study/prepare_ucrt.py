"""Extract app-local UCRT from verified Microsoft SDK 14393 media; never install it."""
import argparse,hashlib,json,re,struct,subprocess,tempfile
from pathlib import Path
SDK_SHA='0d3a5c94143fe14a45bb9608a951dea04cb01bf1ff90003e8c3d80dacfca05be'
CAB_SHA={'9126f6ff98d955951fe9323f4444c119.cab':'3988b3d36c1b4343b0a7d3237a30a3db726af2d17a27dc748a2ee47c7628fd0e','948a611cd2aca64b1e5113ffb7b95d5f.cab':'13719323a05589c3ee7f600794c5d385d692ba1a30d87ce86987b23d511de976','fef2cfedd6135e0ed85290b83f3682c3.cab':'408b2c176fdc7eee8ae5ab4bbd1b65f284d4900448b6c014c8dc90294a98c31d'}
SOURCE='https://download.microsoft.com/download/C/D/8/CD8533F8-5324-4D30-824C-B834C5AD51F9/standalonesdk/'
def digest(b):return hashlib.sha256(b).hexdigest()
def pe_name(b):
    if b[:2]!=b'MZ':return None
    pe=struct.unpack_from('<I',b,60)[0];machine=struct.unpack_from('<H',b,pe+4)[0]
    if machine not in (0x8664,0x14c):return None
    n=struct.unpack_from('<H',b,pe+6)[0];op=pe+24;size=struct.unpack_from('<H',b,pe+20)[0]
    sections=[struct.unpack_from('<8sIIIIIIHHI',b,op+size+40*i) for i in range(n)]
    def offset(rva):
        for s in sections:
            if s[2]<=rva<s[2]+max(s[1],s[3]):return s[4]+rva-s[2]
        return rva
    export=struct.unpack_from('<I',b,op+(112 if machine==0x8664 else 96))[0]
    start=offset(struct.unpack_from('<I',b,offset(export)+12)[0]);name=b[start:b.index(b'\0',start)].decode('ascii').lower()
    if not re.fullmatch(r'(ucrtbase|api-ms-win-[a-z0-9-]+)\.dll',name):raise ValueError('Unexpected UCRT DLL export name')
    return ('x64' if machine==0x8664 else 'x86'),name

def main():
    p=argparse.ArgumentParser();p.add_argument('--sdk-setup',type=Path,required=True);p.add_argument('--cabs-dir',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    raw=a.sdk_setup.read_bytes()
    if digest(raw)!=SDK_SHA:raise ValueError('SDK setup SHA256 mismatch')
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);pos=raw.find(b'MSCF');length=struct.unpack_from('<I',raw,pos+8)[0];cab=root/'ux.cab';cab.write_bytes(raw[pos:pos+length]);ux=root/'ux';ux.mkdir();subprocess.run(['bsdtar','-xf',str(cab),'-C',str(ux)],check=True)
        license_data=(ux/'u2').read_bytes()
        manifest={arch:{'sdk_version':'10.1.14393.795','source_url':SOURCE,'sdk_setup_sha256':SDK_SHA,'cab_sha256':CAB_SHA,'files':{}} for arch in ['x64','x86']}
        for name,expected in CAB_SHA.items():
            cab=a.cabs_dir/name
            if digest(cab.read_bytes())!=expected:raise ValueError('SDK CAB SHA256 mismatch: '+name)
            extracted=root/name;extracted.mkdir();subprocess.run(['bsdtar','-xf',str(cab),'-C',str(extracted)],check=True)
            for f in extracted.glob('fil*'):
                b=f.read_bytes();item=pe_name(b)
                if not item:continue
                arch,dll=item;out=a.out/arch;out.mkdir(parents=True,exist_ok=True)
                if dll in manifest[arch]['files']:raise ValueError('Duplicate DLL')
                (out/dll).write_bytes(b);manifest[arch]['files'][dll]=digest(b)
        for arch,m in manifest.items():
            out=a.out/arch;assert len(m['files'])==41 and 'api-ms-win-crt-runtime-l1-1-0.dll' in m['files']
            (out/'MICROSOFT-SDK-LICENSE.rtf').write_bytes(license_data);m['files']['MICROSOFT-SDK-LICENSE.rtf']=digest(license_data)
            (out/'UCRT-SOURCE.json').write_text(json.dumps(m,sort_keys=True,indent=2)+'\n',encoding='utf-8')
            print('Verified official SDK app-local UCRT:',arch,'41 DLLs')
if __name__=='__main__':main()
