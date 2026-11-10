-- SQL Server 2008及以上。先在SSMS选择已附加副本的教学数据库，再执行。
-- 本脚本只读；不要在原MDF上直接升级或附加。先备份MDF/LDF并使用副本。
SET NOCOUNT ON;
SELECT DB_NAME() AS [当前数据库], SERVERPROPERTY('ProductVersion') AS [服务器版本];
SELECT s.name AS [架构],t.name AS [表名],c.column_id AS [列顺序],c.name AS [列名],
       ty.name AS [类型],c.max_length AS [字节长度],c.precision AS [精度],c.scale AS [小数位],c.is_nullable AS [允许NULL]
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id=t.schema_id
JOIN sys.columns AS c ON c.object_id=t.object_id
JOIN sys.types AS ty ON ty.user_type_id=c.user_type_id
WHERE t.name IN (N'学生表',N'成绩表')
ORDER BY s.name,t.name,c.column_id;
SELECT s.name AS [架构],t.name AS [表名],i.name AS [索引],i.is_unique AS [唯一],i.is_primary_key AS [主键],
       c.name AS [字段],ic.key_ordinal AS [键顺序]
FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
JOIN sys.indexes i ON i.object_id=t.object_id
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE t.name IN (N'学生表',N'成绩表') AND ic.key_ordinal>0
ORDER BY t.name,i.name,ic.key_ordinal;
-- 不假定架构名，逐个读取匹配表的记录数和实际数据，不执行DML。
DECLARE @schema sysname,@table sysname,@sql nvarchar(max);
DECLARE data_cursor CURSOR LOCAL FAST_FORWARD FOR
SELECT s.name,t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
WHERE t.name IN (N'学生表',N'成绩表') ORDER BY t.name,s.name;
OPEN data_cursor;
FETCH NEXT FROM data_cursor INTO @schema,@table;
WHILE @@FETCH_STATUS=0
BEGIN
 SET @sql=N'SELECT N'''+REPLACE(@schema+N'.'+@table,N'''',N'''''')+N''' AS [数据来源],COUNT(*) AS [行数] FROM '+QUOTENAME(@schema)+N'.'+QUOTENAME(@table)+N'; SELECT * FROM '+QUOTENAME(@schema)+N'.'+QUOTENAME(@table)+N';';
 EXEC sp_executesql @sql;
 FETCH NEXT FROM data_cursor INTO @schema,@table;
END;
CLOSE data_cursor;
DEALLOCATE data_cursor;
