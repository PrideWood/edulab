"""Stable lesson IDs and display order; preparation is additive for old archives."""
import copy
PREPARATION_LESSON = 3
COURSE_ORDER = [3, 0, 1, 2]
PREPARATION_POLICY = '全班共同规则：围绕学生刚讲过的本课内容，依次确认查询目标、方法和核对依据。一次只问一个问题，不提供答案，不使用正式组别策略。'
TASKS = [{'id': 'R1',
  'title': '项目五 查询中的常用处理',
  'pages': '项目五正文100–107页，图5-14、5-15、5-18',
  'brief': '教会虚拟学徒解释项目五常用处理。独立实操：列出不重复的籍贯并按籍贯排序；显示学生姓名、籍贯、性别及0女1男的文字列；显示学生姓名、籍贯及“生日为”加出生年月日。参照正文图5-14、5-15、5-18，提交三个案例的SQL和本人运行结果。',
  'points': ['显示需求与来源', '籍贯去重与排序', '性别代码映射', '日期转换', '截取和文字连接', '结果核对'],
  'checks': ['老师，这几个显示需求分别要从哪里取得什么信息？',
             '同一籍贯为什么只显示一次，最后按什么排序？',
             '请教我把0和1显示成女和男。',
             '生日为什么先转换成文字？',
             '怎样保留年月日，再加上生日说明？',
             '请用一条实际记录检查我的复述。']},
 {'id': 'R2',
  'title': '项目六 聚合与分组',
  'pages': '项目六任务一和任务二',
  'brief': '教会虚拟学徒解释课程统计、分组与组条件。独立实操：①限定K01，按班显示班级编号、总成绩、人数、均分；②限定K01，按班级及课程分组，显示两个编号和总成绩人数均分，只保留均分至少80的组，按班级升序、课程降序。参照正文图6-8、6-11，提交两条SQL及本人结果。',
  'points': ['统计范围', '聚合函数的含义', '计数口径', '分组粒度', '行条件与组条件', '结果核查'],
  'checks': ['参与统计的是哪些记录？请先教我确定范围。',
             '最高、最低、总分和均分分别怎样得到？',
             '这里数的是记录、成绩还是学生？请告诉我依据。',
             '按班汇总后，结果的一行代表什么？',
             '行条件和汇总后的条件应怎样区分？请你解释。',
             '请教我用原始成绩核对结果，并检查我有没有理解错。']},
 {'id': 'R3',
  'title': '项目六 子查询与比较',
  'pages': '项目六任务三',
  'brief': '教会虚拟学徒解释内外查询和ANY、ALL。独立实操：以内层B01班K01的成绩为比较集合，查询B02班K01中成绩大于其中至少一个值的记录，再查询成绩大于其中全部值的记录。参照正文图6-14、6-15，提交两条SQL及本人结果。',
  'points': ['查询目标', '内层结果', '外层比较对象', 'ANY的含义', 'ALL的含义', '核查比较边界'],
  'checks': ['请先教我内外两个查询各要解决什么问题。',
             '内层查询给外层提供了哪些比较值？',
             '外层的每个值要和谁比较？',
             'ANY在这里表示什么？请你用教材数据举例。',
             'ALL和ANY的要求有什么不同？',
             '请核对两种结果的边界，并检查我刚才的理解。']},
 {'id': 'P0',
  'title': '项目五 简单查询',
  'pages': '项目五正文87–99页，图5-2、5-8、5-9、5-10',
  'brief': '先教虚拟学徒理解学生表的来源、输出列、筛选条件和排序。独立实操：查询籍贯为黑龙江省的学生，显示学生姓名、籍贯和出生日期；另按出生日期从早到晚显示学生姓名、籍贯、出生日期和按年份差计算的学生年龄。参照正文图5-8、5-10，提交两条SQL及本人运行结果。',
  'points': ['来源与查询目标', '输出列', '选列与筛行', '籍贯匹配', '日期与年龄排序', '核对结果'],
  'checks': ['老师，这次查询要从哪里取得什么信息？',
             '我该显示哪几项信息？',
             '少显示几列和少保留几行分别是什么意思？',
             '籍贯后面还有市名，我怎么判断它属于黑龙江省？',
             '按出生日期从早到晚排列时，我该怎样确定方向？',
             '请用教材的一条记录检查我的理解。']}]

def course_order(p):
    # Old started records retain their original three rounds and immutable snapshots.
    return p.get('course_order', [0, 1, 2] if p.get('rounds') else COURSE_ORDER)

def next_lesson(p):
    completed = {r['index'] for r in p['rounds']}
    return next((i for i in course_order(p) if i not in completed), None)


PREPARATION_TIMING = {'demonstration_minutes':20,'teaching_seconds':900,'practice_seconds':600,'quiz_seconds':600}

def upgrade_config(config):
    cfg=copy.deepcopy(config)
    cfg.setdefault('preparation_timing',copy.deepcopy(PREPARATION_TIMING))
    cfg['prompts'].setdefault('preparation',PREPARATION_POLICY)
    if len(cfg['tasks'])==3:
        cfg['tasks'].append(copy.deepcopy(TASKS[PREPARATION_LESSON]))
        cfg['prompts']['lessons'].append(TASKS[PREPARATION_LESSON]['brief'])
        for rules in cfg['schedules'].values():
            for stage in ('ai','practice','posttest'):
                rules[stage+'3']={'mode':'auto' if stage=='practice' else 'closed','open_at':None,'close_at':None}
    for i in range(3):
        if cfg['tasks'][i]['brief'].startswith('试运行'):
            cfg['tasks'][i]=copy.deepcopy(TASKS[i])
        if cfg['prompts']['lessons'][i].startswith('试运行'):
            cfg['prompts']['lessons'][i]=TASKS[i]['brief']
    return cfg
