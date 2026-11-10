# -*- coding: utf-8 -*-
"""Build Windows x64 EXE on macOS/Linux using Go and verified official CPython."""
import argparse,hashlib,io,json,os,subprocess,urllib.request,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PYTHON_VERSION='3.14.10'
PYTHON_SHA256='90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
PYTHON_URL=f'https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip'
WIN7_SHA256={'x64':'abbe314e9b41603dde0a823b76f5bbbe17b3de3e5ac4ef06b759da5466711271','x86':'760dc79bcb434ee80b1001a30bb6f798287881851bac6d8137867894d40ef1fc'}
def load_ucrt(directory,arch):
    if directory is None:raise ValueError('Win7 builds require --ucrt-dir pointing to verified SDK app-local DLLs')
    manifest=json.loads((ROOT/('ucrt-'+arch+'-manifest.json')).read_text(encoding='utf-8'))
    if json.loads((directory/'UCRT-SOURCE.json').read_text(encoding='utf-8'))!=manifest:raise ValueError('UCRT provenance mismatch')
    from prepare_ucrt import pe_name
    files={}
    for name,expected in manifest['files'].items():
        data=(directory/name).read_bytes()
        if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('UCRT file hash mismatch: '+name)
        if name.endswith('.dll') and pe_name(data)!=(arch,name):raise ValueError('UCRT architecture/name mismatch: '+name)
        files[name]=data
    files['UCRT-SOURCE.json']=(directory/'UCRT-SOURCE.json').read_bytes()
    return files

def main():
    p=argparse.ArgumentParser();p.add_argument('--go',default='go');p.add_argument('--python-zip',type=Path);p.add_argument('--win7',action='store_true');p.add_argument('--arch',choices=['x64','x86'],default='x64');p.add_argument('--ucrt-dir',type=Path);p.add_argument('--config',type=Path,default=ROOT/'.private/runtime.json');a=p.parse_args()
    if not a.win7 and a.arch!='x64':raise SystemExit('The modern runtime is x64 only; use --win7 for x86.')
    version='0.13.1'
    ucrt=load_ucrt(a.ucrt_dir,a.arch) if a.win7 else {}
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
    browser_script=subprocess.check_output(['node',str(ROOT/'compile_browser.mjs')])
    launcher=ROOT/'windows-launcher';release=ROOT/'release';release=release/('win7-'+a.arch) if a.win7 else release;release=release/version;release.mkdir(parents=True,exist_ok=True)
    goroot=Path(subprocess.check_output([a.go,'env','GOROOT'],text=True,encoding='utf-8').strip());licenses='Go runtime\n'+(goroot/'LICENSE').read_text(encoding='utf-8')+'\n\nCPython\n'
    with zipfile.ZipFile(io.BytesIO(runtime)) as original,zipfile.ZipFile(launcher/'payload.zip','w',zipfile.ZIP_DEFLATED) as payload:
        licenses+=original.read('LICENSE.txt').decode()
        for f in original.infolist():
            if f.filename.startswith('/') or '..' in Path(f.filename).parts:raise ValueError('Invalid runtime path')
            payload.writestr(f,original.read(f))
        for name,data in ucrt.items():payload.writestr(name,data)
        for name in ['boot.py','server.py','study_control.py','course_layout.py','research_protocol.py','teaching_clock.py','task_access.py','research_defaults.json','cloud_connection.py','questions.json']:
            payload.write(ROOT/name,name)
        for f in (ROOT/'web').glob('*'):
            if f.is_file():
                if f.name=='app.js':payload.writestr('web/app.js',browser_script)
                else:payload.write(f,'web/'+f.name)
        payload.writestr('.private/runtime.json',json.dumps(config,ensure_ascii=False))
        payload.writestr('THIRD_PARTY_LICENSES.txt',licenses)
        payload.writestr('BUILDINFO.json',json.dumps({'app':'EduLab SQL','version':version,'target':'windows/'+goarch,'ucrt_deployment':'app-local-sdk-14393' if a.win7 else 'system','ucrt_dll_count':41 if a.win7 else 0,'system_install_required':False,'minimum_windows':'Windows 7 SP1' if a.win7 else 'Windows 10','go_version':goversion,'python_version':python_version,'python_url':python_url,'python_sha256':python_sha,'timers':'individual-ai-advisory-practice-quiz','teaching_window_policy':'foreground-active/1','console':'minimize-after-browser-ready','portable_entry':'Start-Classroom.cmd','online_url':'https://edulab.dacnote.com/sql-student','student_data_included':False,'browser_baseline':'Chrome 69','browser_target':'69.0.3497.81','browser_script':'ES2017 compiled','scheme_version':'business-workorders/1','research_version':'sql-lt/1.1','first_lesson':'grouped-preparation-LT','formal_rounds':4,'lesson_access':'current-task-only','stage_access':'teaching-practice-quiz'},indent=2))
    (launcher/'payload.zip').chmod(0o600)
    with zipfile.ZipFile(launcher/'payload.zip') as packaged:
        (release/'BUILDINFO.json').write_bytes(packaged.read('BUILDINFO.json'))
    subprocess.run([a.go,'test','./...'],cwd=launcher,check=True)
    out=release/'EduLab-SQL.exe';env={**os.environ,'GOOS':'windows','GOARCH':goarch,'CGO_ENABLED':'0','GOTOOLCHAIN':'local'}
    subprocess.run([a.go,'build','-trimpath','-ldflags=-s -w -buildid=','-o',str(out),'.'],cwd=launcher,env=env,check=True)
    content=out.read_bytes();offset=int.from_bytes(content[60:64],'little')
    if content[:2]!=b'MZ' or content[offset:offset+6]!=(b'PE\x00\x00'+(b'\x4c\x01' if a.arch=='x86' else b'\x64\x86')):raise ValueError('Windows PE architecture mismatch')
    digest=hashlib.sha256(content).hexdigest();(release/'SHA256SUMS.txt').write_text(digest+'  EduLab-SQL.exe\n',encoding='ascii');(release/'THIRD_PARTY_LICENSES.txt').write_text(licenses,encoding='utf-8')
    instructions='''EduLab SQL Windows 64位 MVP（0.13.1）\n\n1. 完整解压后优先双击 Start-Classroom.cmd；也可使用 EduLab-SQL.exe，无须安装Python、Node或SQL平台服务。\n2. 程序优先打开Chrome。CMD入口保留服务窗口；EXE在确认浏览器启动后才最小化。实验期间保留该窗口；关闭它会停止本机服务。\n3. 选择班级、输入姓名并确认。先完成前测与课前问卷，教师按基线完成L/T分组后进入准备课P0，随后四次正式业务工单跨课固定组别。P0最多6轮、正式最多12轮；到上限或个人计时结束后收束，不设最低字数。个人教学徒时段结束填写精神努力（必答），再进入独立实操。量表和测试题全部必答，不采集成绩估算。系统仅显示教师指定的当次任务，无日期或定时开放限制；每课按教学徒、独立SSMS实操、测评依次进行，教学时段结束后才能进入实操；实操开始后不能返回AI。旧方案记录完整保存在scheme_history，不混入新轮次。\n4. AI仅在对话界面处于前台时累计用时，离开或切换窗口暂停；晚进入不被共同窗口拒绝，按累计时长和轮次收束；实操与后测计时仍为建议，完成后请主动提交。实际用时持续记录。\n5. 模型交互与云端同步需要网络。本机先保存，联网后自动补传；密钥与连接已经内置，无须学生配置。\n6. 数据保存在 %LOCALAPPDATA%\\EduLab-SQL，升级程序不会清空此目录。升级前先关闭旧服务窗口；再次双击正在运行的程序会打开原页面。\n7. 此包内置受控课堂的模型连接，仅限本实验分发；不要上传到公开下载站或源码仓库。\n8. 目标为Windows 10/11 x64，需要系统已安装Chrome 69或更新版本（或相应版本Edge）。若EXE没有任何文字，使用CMD入口绕过EXE启动器；异常时保留startup-diagnostic.log。线上备选：https://edulab.dacnote.com/sql-student。本次已验证应用逻辑、启动器逻辑和PE结构；仍需在学生Windows电脑上进行端到端验收。\n'''
    if a.win7:
        instructions=instructions.replace('64位 MVP（0.13.1）',('32位' if a.arch=='x86' else '64位')+' Win7兼容版（0.13.1）').replace('目标为Windows 10/11 x64','目标为Windows 7 SP1 '+a.arch)
        instructions+='\nWin7环境要求：须为SP1。本包已将微软SDK 14393的完整UCRT运行库放在Python可执行文件旁边，不安装系统补丁，不写System32，不请求系统重启。两个启动入口均已内置。若仍提示缺少DLL，请保留报错原文，以排查其他系统依赖。本版机房浏览器目标为Chrome 69.0.3497.81；不支持IE。32位包可用于32/64位系统，64位包只能用于64位系统。\n未在真实Win7机器验收，首次部署请先在一台学生机完成登录、文字/图片交互、实操提交及云备份检查。\n'
    (release/'Windows使用说明.txt').write_text(instructions,encoding='utf-8-sig')
    portable=release/'runtime';portable.mkdir(exist_ok=True)
    with zipfile.ZipFile(launcher/'payload.zip') as packed:
        for member in packed.infolist():
            target=portable/member.filename;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(packed.read(member))
    (release/'Start-Classroom.cmd').write_bytes((ROOT/'Start-Classroom.cmd').read_bytes().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))
    (release/'Online-Classroom.url').write_text('[InternetShortcut]\nURL=https://edulab.dacnote.com/sql-student\n',encoding='ascii')
    bundle=release/(f'EduLab-SQL-{version}-Win7-{a.arch}.zip' if a.win7 else f'EduLab-SQL-{version}-Windows-x64.zip')
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED) as z:
        for f in [out,release/'SHA256SUMS.txt',release/'THIRD_PARTY_LICENSES.txt',release/'Windows使用说明.txt',release/'BUILDINFO.json']:z.write(f,'EduLab-SQL/'+f.name)
        for f in portable.rglob('*'):
            if f.is_file():z.write(f,'EduLab-SQL/runtime/'+f.relative_to(portable).as_posix())
        for name in ['Start-Classroom.cmd','Online-Classroom.url']:z.write(release/name,'EduLab-SQL/'+name)
    out.chmod(0o700);bundle.chmod(0o600)
    print('Built Windows '+a.arch+' EXE:',out.stat().st_size,'bytes; SHA256',digest)
    print('Package:',bundle)
if __name__=='__main__':main()
