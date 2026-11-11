# Win7证书与真实模型启动入口

应用核心仍为0.15.0，分发包的默认 `Start-Classroom.cmd` 应依次：

1. 设置进程级 `SSL_CERT_FILE`，验证CA文件哈希、证书校验及域名校验均启用。
2. 使用runtime里的Python3.8运行根目录 `prepare_live_classroom.py`。
3. 该脚本取得同一个service.lock，确认旧服务已关闭；同步云端配置，必须为real且已有模型连接，否则退出，不启动演示课堂。
4. 仅将测试身份的旧demo轮次复制到 `test_lesson_history`，保留消息、答卷、截图元数据与组别，不改正式学生记录或已有real轮次。
5. 释放启动准备锁，然后调用原始 `Start-Classroom-Base.cmd` 启动应用。备用EXE也应经相同准备流程启动。

准备脚本放在分发根目录，与runtime同级；来源为 `student-client/sql-study/prepare_live_classroom.py`。不得直接启动Base入口或tools里的EXE，否则不具备证书环境和启动前真实模型同步。

`0039_sql_preserve_archived_pilot_group.sql` 保证试测归档后原组别不因刷新重抽。新试测身份仍按0038稳定随机L/T。正式学生继续完成前测、问卷及班级分组；同名不同UUID的档案按各自标记处理，不按姓名全局排除。

运行期间网络或模型失败只报错，原real轮次不降级为demo。核心客户端的模型错误处理已经遵守此规则，启动脚本不提供伪造回复。
