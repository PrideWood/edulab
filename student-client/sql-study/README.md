# EduLab SQL 0.12.0：当次任务版

当前机房：Windows 7 64位、Chrome 69.0.3497.81。分发Win7 x64包；不需要学生安装Python或Node。数据库操作继续使用SSMS和真实SQL Server，不由平台模拟运行结果。

教师在后台“当次任务”中为各班选择P0或正式第1—4课。学生只显示并完成当次任务，无日期、开放时刻、截止时刻限制，也不会自动进入下一课。前测和13题前问卷仍保留，正式学生完成基线后在班内固定L/T分组；P0即执行各组策略。

教学徒仅在对话页面可见且窗口处于前台时累计计时，离开暂停。P0最多6轮，正式课最多12轮；保留收束规则、精神努力卡、提交前预估分、独立实操和测评。不设置最低字数。

柴博泉、测试、test、ceshi及已标记测试身份始终不参加正式分组，回收站记录不参加分组。测试账号完成真实基线并同步后自动获得学徒；后台可切换或重置试测任务。旧测试记录本次先私有备份后清理，新客户端为旧测试账号创建干净身份。正式学生有效记录保留。

完整操作、研究测量与清理规则见[操作说明](../../docs/sql-research-protocol.md)。D1教师答案不随源码或Windows包分发；登录后台下载。

## 构建与检查

在仓库执行`npm ci`，准备受限学生连接的私有运行配置及官方Python3.8嵌入包，使用Go1.20构建Win7目标。`build_windows.py --win7 --arch x64`会验证Python校验值，调用`compile_browser.mjs`将学生脚本转换为ES2017，并打包浏览器接口和样式回退。原始开发脚本保留现代语法，Windows包中使用转换后的脚本。

- Python：`python3 -m unittest discover -s student-client/sql-study/tests`
- 浏览器：`node --test student-client/sql-study/tests/*.mjs`
- Chrome69编译版：`SQL_STUDENT_CHROME69=1 node --test student-client/sql-study/tests/test_live_refresh.mjs`
- 后台：`npm test`、`npx tsc --noEmit`、`npm run build`

部署执行0030、0031迁移；含清理操作的0031执行前必须备份旧SQL测试快照、分组、评分、试测命令及配置。只清理SQL测试身份，禁止清空正式学生或其他应用记录。私有配置、运行数据库、payload.zip和清理备份不提交仓库。

版本升级前先关闭旧服务，复用原数据目录。Win7应有SP1和所需系统运行库；尚需在实际机房单机验收登录、文字/图片交互、暂停恢复、实操提交和云备份。语法转换与自动化检查不等于真机验收。

线上入口：https://edulab.dacnote.com/sql-student。本机优先使用Start-Classroom.cmd；两种方式与排障边界详见docs/sql-dual-deployment.md。
