-- 从用户提供的script.sql提取；保留六表结构和68条原始记录，不修改原件。
-- 兼容SQL Server 2008查询教学；先手动新建并选中空的专用教学库。
-- 不要在master或已有数据的数据库中运行。整份脚本为同一个批次，无GO。
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() IN (N'master',N'model',N'msdb',N'tempdb')
BEGIN
 RAISERROR(N'请先选择空的专用教学数据库。',16,1);
 RETURN;
END;
IF EXISTS(SELECT 1 FROM sys.tables WHERE is_ms_shipped=0)
BEGIN
 RAISERROR(N'当前数据库已有用户表，本脚本不覆盖。',16,1);
 RETURN;
END;
BEGIN TRY
 BEGIN TRANSACTION;
CREATE TABLE [dbo].[班级表](
	[班级编号] [char](3) NOT NULL,
	[所属专业编号] [char](3) NULL,
	[班主任编号] [char](4) NULL
) ON [PRIMARY];

CREATE TABLE [dbo].[成绩表](
	[班级编号] [char](10) NULL,
	[学生编号] [char](10) NULL,
	[选修课程编号] [char](10) NULL,
	[成绩] [decimal](9, 2) NULL
) ON [PRIMARY];

CREATE TABLE [dbo].[教师表](
	[教师姓名] [varchar](10) NOT NULL,
	[教师编号] [varchar](10) NULL,
	[职务] [varchar](10) NULL,
	[性别] [int] NULL,
	[出生日期] [varchar](50) NULL,
	[入职日期] [varchar](50) NULL
) ON [PRIMARY];

CREATE TABLE [dbo].[课程表](
	[课程编号] [char](3) NOT NULL,
	[课程名称] [varchar](50) NULL,
	[课时] [float] NULL,
	[所属专业编号] [char](3) NULL,
	[教师编号] [char](4) NULL
) ON [PRIMARY];

CREATE TABLE [dbo].[学生表](
	[学生编号] [varchar](10) NOT NULL,
	[学生姓名] [varchar](10) NULL,
	[所属专业编号] [char](3) NULL,
	[所属班级编号] [char](3) NULL,
	[职务] [varchar](10) NULL,
	[性别] [int] NULL,
	[出生日期] [datetime] NULL,
	[籍贯] [varchar](60) NULL,
	[入学日期] [datetime] NULL
) ON [PRIMARY];

CREATE TABLE [dbo].[专业表](
	[专业编号] [char](3) NOT NULL,
	[专业名称] [varchar](20) NULL
) ON [PRIMARY];

INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B01', N'Z01', N'J002');
INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B02', N'Z01', N'J003');
INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B03', N'Z02', N'J005');
INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B04', N'Z02', N'J006');
INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B05', N'Z03', N'J009');
INSERT [dbo].[班级表] ([班级编号], [所属专业编号], [班主任编号]) VALUES (N'B06', N'Z03', N'J010');
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X001      ', N'K01       ', CAST(95.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X001      ', N'K02       ', CAST(85.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B02       ', N'X005      ', N'K04       ', CAST(55.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B03       ', N'X006      ', N'K05       ', CAST(78.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X002      ', N'K01       ', CAST(88.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X002      ', N'K02       ', CAST(77.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B03       ', N'X006      ', N'K06       ', CAST(68.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X003      ', N'K01       ', CAST(66.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B01       ', N'X003      ', N'K02       ', CAST(55.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B02       ', N'X004      ', N'K04       ', CAST(95.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B03       ', N'X007      ', N'K05       ', CAST(87.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B03       ', N'X007      ', N'K06       ', CAST(53.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B04       ', N'X008      ', N'K07       ', CAST(99.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B04       ', N'X009      ', N'K07       ', CAST(89.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B05       ', N'X010      ', N'K08       ', CAST(90.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B05       ', N'X011      ', N'K08       ', CAST(80.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B06       ', N'X013      ', N'K09       ', CAST(60.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B02       ', N'X004      ', N'K01       ', CAST(70.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (N'B02       ', N'X005      ', N'K01       ', CAST(99.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (NULL, N'T001      ', N'K01       ', CAST(99.00 AS Decimal(9, 2)));
INSERT [dbo].[成绩表] ([班级编号], [学生编号], [选修课程编号], [成绩]) VALUES (NULL, N'T002      ', N'K01       ', CAST(80.00 AS Decimal(9, 2)));
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'陈伟英', N'j002', N'辅导员', 0, N'1935-7-27', N'1998-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'陈伟豪', N'j003', N'辅导员', 0, N'1940-6-6', N'1998-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'陈豪丽', N'j004', N'教师', 0, N'1939-10-2', N'1996-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'王琛', N'j005', N'辅导员', 1, N'1938-9-3', N'1997-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'文翠霞', N'j006', N'辅导员', 0, N'1934-5-6', N'1997-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'陈维雄', N'j007', N'教师', 1, N'1938-4-1', N'1996-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'徐家忠', N'j008', N'教师', 1, N'1934-12-1', N'1999-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'董敏', N'j009', N'辅导员', 1, N'1934-11-6', N'1999-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'何云汉', N'j010', N'教师', 1, N'1900-5-1', N'1999-7-1');
INSERT [dbo].[教师表] ([教师姓名], [教师编号], [职务], [性别], [出生日期], [入职日期]) VALUES (N'王兆安', N'j011', N'教师', 1, N'1972-5-9', N'1999-7-1');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'K01', N'数据结构', 30, N'z01', N'j002');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k02', N'数据库原理', 40, N'z01', N'j003');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k03', N'编译原理', 50, N'z01', N'j002');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k04', N'计算机原理', 60, N'z01', N'j002');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k05', N'建筑制图', 50, N'z02', N'j005');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k06', N'建筑结构', 30, N'z02', N'j005');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k07', N'模型制作', 60, N'z02', N'j005');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k08', N'素描基础', 70, N'z03', N'j008');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k09', N'色彩构成', 50, N'z03', N'j009');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k10', N'自动控制原理', 60, N'z01', NULL);
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k11', N'电气控制原理', 55, N'z01', NULL);
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k12', N'中医基础', 30, N'z01', N'j004');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k13', N'护理基础', 40, N'a01', N'j004');
INSERT [dbo].[课程表] ([课程编号], [课程名称], [课时], [所属专业编号], [教师编号]) VALUES (N'k14', N'病理学', 60, N'z01', N'j011');
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X001', N'宋小南', N'Z01', N'B01', N'班长', 0, CAST(N'1980-08-01T00:00:00.000' AS DateTime), N'黑龙江省哈尔滨市', CAST(N'2001-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X002', N'宋雪燕', N'Z01', N'B01', N'学生', 0, CAST(N'1982-12-26T00:00:00.000' AS DateTime), N'北京市', CAST(N'2001-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X003', N'张经纬', N'Z01', N'B01', N'学生', 1, CAST(N'1981-10-10T00:00:00.000' AS DateTime), N'北京市', CAST(N'2001-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X004', N'张黎辉', N'Z01', N'B02', N'班长', 1, CAST(N'1983-06-02T00:00:00.000' AS DateTime), N'辽宁省沈阳市', CAST(N'2002-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X005', N'张黎阳', N'Z01', N'B02', N'学生', 1, CAST(N'1983-04-12T00:00:00.000' AS DateTime), N'上海市', CAST(N'2002-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X006', N'王霞', N'Z02', N'B03', N'班长', 0, CAST(N'1973-05-06T00:00:00.000' AS DateTime), N'黑龙江省齐齐哈尔市', CAST(N'2001-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X007', N'王旭', N'Z02', N'B03', N'学生', 0, CAST(N'1978-04-01T00:00:00.000' AS DateTime), N'北京市', CAST(N'2001-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X008', N'曹轩明', N'Z02', N'B04', N'班长', 1, CAST(N'1984-05-05T00:00:00.000' AS DateTime), N'福建省厦门市', CAST(N'2002-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X009', N'曹万里', N'Z02', N'B04', N'学生', 1, CAST(N'1977-12-10T00:00:00.000' AS DateTime), N'重庆市', CAST(N'2002-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X010', N'包海中', N'Z03', N'B05', N'班长', 1, CAST(N'1980-11-08T00:00:00.000' AS DateTime), N'新疆乌鲁木齐市', CAST(N'2003-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X011', N'郑贤淑', N'Z03', N'B05', N'学生', 0, CAST(N'1984-09-07T00:00:00.000' AS DateTime), N'北京市', CAST(N'2003-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X012', N'王忆浦', N'Z03', N'B06', N'班长', 0, CAST(N'1982-03-21T00:00:00.000' AS DateTime), N'云南昆明市', CAST(N'2004-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[学生表] ([学生编号], [学生姓名], [所属专业编号], [所属班级编号], [职务], [性别], [出生日期], [籍贯], [入学日期]) VALUES (N'X013', N'薛智', N'Z03', N'B06', N'学生', 1, CAST(N'1976-01-01T00:00:00.000' AS DateTime), N'上海市', CAST(N'2004-09-01T00:00:00.000' AS DateTime));
INSERT [dbo].[专业表] ([专业编号], [专业名称]) VALUES (N'Z01', N'计算机系');
INSERT [dbo].[专业表] ([专业编号], [专业名称]) VALUES (N'Z02', N'建筑系');
INSERT [dbo].[专业表] ([专业编号], [专业名称]) VALUES (N'Z03', N'美术系');
INSERT [dbo].[专业表] ([专业编号], [专业名称]) VALUES (N'Z04', N'中医护理');
 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
 IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;
 DECLARE @message nvarchar(2048);
 SET @message=ERROR_MESSAGE();
 RAISERROR(@message,16,1);
END CATCH;
