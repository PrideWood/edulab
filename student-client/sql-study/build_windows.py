# -*- coding: utf-8 -*-
"""Build Windows x64 EXE on macOS/Linux using Go and verified official CPython."""
import argparse,hashlib,io,json,os,subprocess,urllib.request,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PYTHON_VERSION='3.14.10'
PYTHON_SHA256='90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
PYTHON_URL=f'https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip'
WIN7_SHA256={'x64':'abbe314e9b41603dde0a823b76f5bbbe17b3de3e5ac4ef06b759da5466711271','x86':'760dc79bcb434ee80b1001a30bb6f798287881851bac6d8137867894d40ef1fc'}
def main():
    p=argparse.ArgumentParser();p.add_argument('--go',default='go');p.add_argument('--python-zip',type=Path);p.add_argument('--win7',action='store_true');p.add_argument('--arch',choices=['x64','x86'],default='x64');p.add_argument('--config',type=Path,default=ROOT/'.private/runtime.json');a=p.parse_args()
    if not a.win7 and a.arch!='x64':raise SystemExit('The modern runtime is x64 only; use --win7 for x86.')
    version='0.9.0'
    python_version='3.8.10' if a.win7 else PYTHON_VERSION
    python_sha=WIN7_SHA256[a.arch] if a.win7 else PYTHON_SHA256
    python_url=f'https://www.python.org/ftp/python/{python_version}/python-{python_version}-embed-'+('win32' if a.arch=='x86' else 'amd64')+'.zip'
    goarch='386' if a.arch=='x86' else 'amd64'
    goversion=subprocess.check_output([a.go,'env','GOVERSION'],text=True,encoding='utf-8').strip()
    if a.win7 and not goversion.startswith('go1.20.'):raise SystemExit('Win7 requires the official Go 1.20.x compiler; newer Go cannot target Win7.')
    config=json.loads(a.config.read_text(encoding='utf-8'))
    from urllib.parse import urlsplit
    if config.get('source')!='windows-direct' or urlsplit(config.get('database_url','')).username!='edulab_sql_student_v1' or not config.get('token'):raise SystemExit('Requires the restricted SQL client configuration; owner credentials are not accepted.')
    runtime=a.python_zip.read_bytes() if a.python_zip else urllib.request.urlopen(python_url,timeout=60).read(40000000)
    if hashlib.sha256(runtime).hexdigest()!=python_sha:raise SystemExit('Official Python runtime SHA256 mismatch')
    launcher=ROOT/'windows-launcher';release=ROOT/'release';release=release/('win7-'+a.arch) if a.win7 else release;release.mkdir(parents=True,exist_ok=True)
    goroot=Path(subprocess.check_output([a.go,'env','GOROOT'],text=True,encoding='utf-8').strip());licenses='Go runtime\n'+(goroot/'LICENSE').read_text(encoding='utf-8')+'\n\nCPython\n'
    with zipfile.ZipFile(io.BytesIO(runtime)) as original,zipfile.ZipFile(launcher/'payload.zip','w',zipfile.ZIP_DEFLATED) as payload:
        licenses+=original.read('LICENSE.txt').decode()
        for f in original.infolist():
            if f.filename.startswith('/') or '..' in Path(f.filename).parts:raise ValueError('Invalid runtime path')
            payload.writestr(f,original.read(f))
        for name in ['server.py','study_control.py','course_layout.py','cloud_connection.py','questions.json']:
            payload.write(ROOT/name,name)
        for f in (ROOT/'web').glob('*'):
            if f.is_file():payload.write(f,'web/'+f.name)
        payload.writestr('.private/runtime.json',json.dumps(config,ensure_ascii=False))
        payload.writestr('THIRD_PARTY_LICENSES.txt',licenses)
        payload.writestr('BUILDINFO.json',json.dumps({'app':'EduLab SQL','version':version,'target':'windows/'+goarch,'minimum_windows':'Windows 7 SP1' if a.win7 else 'Windows 10','go_version':goversion,'python_version':python_version,'python_url':python_url,'python_sha256':python_sha,'timers':'advisory','console':'auto-minimize','student_data_included':False,'browser_baseline':'Chrome 95','scheme_version':'business-workorders/1','first_lesson':'shared-preparation-P','formal_rounds':4,'lesson_access':'preparation-before-formal','stage_access':'teaching-practice-quiz'},indent=2))
    (launcher/'payload.zip').chmod(0o600)
    with zipfile.ZipFile(launcher/'payload.zip') as packaged:
        (release/'BUILDINFO.json').write_bytes(packaged.read('BUILDINFO.json'))
    subprocess.run([a.go,'test','./...'],cwd=launcher,check=True)
    out=release/'EduLab-SQL.exe';env={**os.environ,'GOOS':'windows','GOARCH':goarch,'CGO_ENABLED':'0','GOTOOLCHAIN':'local'}
    subprocess.run([a.go,'build','-trimpath','-ldflags=-s -w -buildid=','-o',str(out),'.'],cwd=launcher,env=env,check=True)
    content=out.read_bytes();offset=int.from_bytes(content[60:64],'little')
    if content[:2]!=b'MZ' or content[offset:offset+6]!=(b'PE\x00\x00'+(b'\x4c\x01' if a.arch=='x86' else b'\x64\x86')):raise ValueError('Windows PE architecture mismatch')
    digest=hashlib.sha256(content).hexdigest();(release/'SHA256SUMS.txt').write_text(digest+'  EduLab-SQL.exe\n',encoding='ascii');(release/'THIRD_PARTY_LICENSES.txt').write_text(licenses,encoding='utf-8')
    instructions='''EduLab SQL Windows 64位 MVP（0.9.0）\n\n1. 解压后双击 EduLab-SQL.exe，无须安装Python、Node或SQL平台服务。\n2. 程序会打开本机默认浏览器，并最小化服务窗口。实验期间保留该窗口；关闭它会停止本机服务。\n3. 选择班级、输入姓名并确认。先完成前测与课前问卷，进入全班共同准备课P0，无需分组。准备课完成后，教师按前测完成L/T分组，再进行四次正式业务工单。每课按教学徒、独立SSMS实操、测评依次进行，教学时段结束后才能进入实操；实操开始后不能返回AI。旧方案记录完整保存在scheme_history，不混入新轮次。\n4. 时间仅作建议：归零不会打断对话、实操或后测；完成后请主动提交。实际用时持续记录。\n5. 模型交互与云端同步需要网络。本机先保存，联网后自动补传；密钥与连接已经内置，无须学生配置。\n6. 数据保存在 %LOCALAPPDATA%\\EduLab-SQL，升级程序不会清空此目录。升级前先关闭旧服务窗口；再次双击正在运行的程序会打开原页面。\n7. 此包内置受控课堂的模型连接，仅限本实验分发；不要上传到公开下载站或源码仓库。\n8. 目标为Windows 10/11 x64，需要系统已安装Chrome 95或更新版本（或相应版本Edge）。本次已验证应用逻辑、原生启动器和PE结构；仍需在学生Windows电脑上进行端到端验收。\n'''
    if a.win7:
        instructions=instructions.replace('64位 MVP（0.9.0）',('32位' if a.arch=='x86' else '64位')+' Win7兼容版（0.9.0）').replace('目标为Windows 10/11 x64','目标为Windows 7 SP1 '+a.arch)
        instructions+='\nWin7环境要求：须安装SP1、Universal C Runtime（KB2999226或替代更新）及支持安全DLL加载的更新（KB2533623/KB3063858或替代更新）。由机房管理员按系统位数安装官方更新；程序不会自动修改系统。若提示缺少api-ms-win-crt等DLL，请先补齐运行库。浏览器推荐现有Chrome95–109；不支持IE。32位包可用于32/64位系统，64位包只能用于64位系统。\n未在真实Win7机器验收，首次部署请先在一台学生机完成登录、文字/图片交互、实操提交及云备份检查。\n'
    (release/'Windows使用说明.txt').write_text(instructions,encoding='utf-8-sig')
    bundle=release/(f'EduLab-SQL-{version}-Win7-{a.arch}.zip' if a.win7 else f'EduLab-SQL-{version}-Windows-x64.zip')
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED) as z:
        for f in [out,release/'SHA256SUMS.txt',release/'THIRD_PARTY_LICENSES.txt',release/'Windows使用说明.txt',release/'BUILDINFO.json']:z.write(f,'EduLab-SQL/'+f.name)
    out.chmod(0o700);bundle.chmod(0o600)
    print('Built Windows '+a.arch+' EXE:',out.stat().st_size,'bytes; SHA256',digest)
    print('Package:',bundle)
if __name__=='__main__':main()
