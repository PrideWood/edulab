"""Business workorders: one common preparation and four formal rounds."""
import copy
SCHEME_VERSION = 'business-workorders/1'
PREPARATION_LESSON = 4
COURSE_ORDER = [4, 0, 1, 2, 3]
PREPARATION_POLICY = '全班共同训练学徒：仅围绕学生表的SELECT选列、FROM来源、结果列顺序、本人执行及提交流程，按共同练习点追问并请学生核对复述。准备课不采用L/T差异化策略，不扩展WHERE、聚合、分组或子查询，不提供独立任务完整答案。'
TASKS = [{'id': 'T1',
  'title': '指定学生群体的学籍核查包',
  'pages': '微课1：学籍筛选、日期显示、排序与基础聚合',
  'brief': '教务处要核查一批学生：**籍贯为北京市，或籍贯以黑龙江省开头；同时出生日期从1978年1月1日起，到1982年1月1日前。**请提交：\n'
           '\n'
           '1. **规范明细。**显示姓名、籍贯、原出生日期、参考年龄和“出生日期：年月日”说明；按出生日期升序、同日按姓名升序。参考年龄统一为2022减出生年份。\n'
           '2. **同范围概况。**统计上述同一批学生的人数、最小参考年龄和最大参考年龄。\n'
           '3. **核验说明。**核对明细行数与统计人数，选择一条记录说明为什么应保留，并解释日期边界。\n'
           '\n'
           '最低交付：两条查询及其实际结果、一段核验说明。\n'
           '\n'
           '**可选挑战：**输出同一批学生不重复的籍贯清单；先读共同参考卡中的DISTINCT说明。挑战结果单独记录，不计核心完成标准，也不是后测新增必考知识。\n'
           '\n'
           '**需教学徒的关键点：**班级字段与来源、括号表达的范围、日期边界、固定年龄口径、转换与截取、明细和统计如何对应。',
  'points': ['目标与数据来源', '组合条件与日期边界', '参考年龄口径', '日期显示与排序', '同范围人数与年龄概况', '明细统计交叉核验'],
  'checks': ['老师，这份核查包从哪里取得哪些信息？',
             '籍贯的或者条件怎样与日期范围同时满足？请教我判断边界。',
             '参考年龄用哪一年，为什么不能直接当成现在的精确周岁？',
             '日期怎样变成说明文字，结果按什么顺序显示？',
             '统计人数和年龄概况时，应该保留哪些相同条件？',
             '请用明细行数和一条实际记录检查我的复述。']},
 {'id': 'T2',
  'title': 'K01课程质量简报',
  'pages': '微课2：CASE、聚合、GROUP BY与HAVING',
  'brief': '为K01课程制作一份质量简报。**统一范围：课程为K01，且班级编号为B01或B02；未分配班级的记录不纳入本次核心报告，所有明细、统计与筛组使用同一范围。**\n'
           '\n'
           '1. '
           '显示班级编号、学生编号、成绩和成绩类别：90分及以上为“优秀”，80分及以上但不足90为“良好”，60分及以上但不足80为“达标”，其余为“未达标或待核对”；按成绩降序、同分按学生编号升序。\n'
           '2. 按班汇总K01人数、总分、均分、最高分与最低分。\n'
           '3. 只保留K01班级均分至少80的统计结果，按均分降序、同均分按班级编号升序。\n'
           '4. 写两至三句简报：哪些班符合条件？“班级均分至少80”能否推出每名学生都至少80？用一条原始成绩给证据。\n'
           '\n'
           '最低交付：三条查询及其结果、一段简报。第2项与第3项允许在同一查询基础上修改，但两个所需结果应能核对。当前脚本在上述范围内成绩非空、每名学生一条记录，因此可按行计人数。真实表未声明唯一约束，若现场数据改变须先核查重复，不能默认由主键保证。\n'
           '\n'
           '**可选挑战：**解释为何不能把两个班均分简单相加除以二，来代替全部学生的均分；不要求新增查询。\n'
           '\n'
           '**需教学徒的关键点：**CASE条件顺序、K01范围、一行代表一个班、WHERE与HAVING、均分与个人成绩的区别。',
  'points': ['课程与记录范围', '成绩分类与边界', '人数总分均分及极值', '按班统计粒度', '行条件与组条件', '简报结论及反例核验'],
  'checks': ['参与这份课程简报的是哪些成绩？',
             'CASE中的等级条件按什么顺序判断，端点算在哪类？',
             '这里为什么可以用记录数表示人数，总分和均分怎样核验？',
             '按班汇总后，一行代表什么？',
             '班级均分至少80，为什么不能先删掉个人不到80的记录？',
             '请用一条原始成绩检查均分达标是否表示每个人都达标。']},
 {'id': 'T3',
  'title': '跨班成绩参照名单',
  'pages': '微课3：子查询、ANY／ALL与名单统计',
  'brief': '以**B01班K01成绩**作为参照，为B02班K01制作两类名单：\n'
           '\n'
           '1. 名单A：成绩严格高于参照班至少一个成绩。\n'
           '2. 名单B：成绩严格高于参照班全部成绩。\n'
           '3. 为两个名单分别统计人数及平均成绩，明确统计的是各自名单，不是B02全部学生。\n'
           '4. 用实际分数解释两名单的包含关系，并说明“等于参照班最高分”是否满足名单B。\n'
           '\n'
           '明细至少显示学生编号、班级编号和成绩，并按成绩降序、同分按编号升序。最低交付：两条名单查询、一条或两条统计查询，以及核验说明。统计允许在名单条件上增加聚合，不能改变参照范围。\n'
           '\n'
           '**可选挑战：**在参照集合非空且无NULL时，用MIN／MAX解释两类比较阈值；必须说明前提，不要求替换正式查询。\n'
           '\n'
           '**需教学徒的关键点：**谁是候选班、谁是参照班，内外层课程限制，至少一次与全部比较，严格大于与等于，汇总仍须沿用名单条件。',
  'points': ['候选班与参照班', '内层课程及成绩集合', 'ANY至少一次成立', 'ALL全部成立与严格边界', '名单人数与均分范围', '包含关系与逐值核验'],
  'checks': ['谁是候选班，谁提供参照，比较的是哪门课？',
             '内层查询给外层哪些成绩值？',
             '大于至少一个值时，怎样逐次判断ANY？',
             '大于全部值与等于最高分有什么区别？',
             '统计名单人数与均分时，哪些条件不能丢掉？',
             '请用原始分数核对两份名单，并检查包含关系。']},
 {'id': 'T4',
  'title': '学籍与成绩综合验收报告',
  'pages': '微课4：需求拆解、分类汇总与查询验收',
  'brief': '提交一份包含四部分的验收报告。已有知识组合使用，不增加新SQL语法。\n'
           '\n'
           '**A. 学籍整理与分类汇总**\n'
           '\n'
           '- 保留“职务为班长，或所属班级为B03”，同时入学日期早于2002年9月1日的学生。\n'
           '- 明细显示姓名、所属班级、职务、参考年龄及规范出生日期说明；用CASE把班长显示为“学生骨干”，其他显示为“普通学生”；按班级、姓名升序。\n'
           '- 对同一批记录按上述显示类别统计人数。\n'
           '\n'
           '**B. 成绩分组验收**\n'
           '\n'
           '- 限定K01且班级为B01或B02，按班显示人数、均分和最低分；未分配班级不纳入本次报告。\n'
           '- 仅保留均分至少84的班级，按均分降序、同均分按班级升序。\n'
           '\n'
           '**C. 跨班参照验收**\n'
           '\n'
           '- 以B02班K01为参照，找出B01班K01中严格低于参照班全部成绩的记录，显示学生编号与成绩，并用原始分数核验。\n'
           '\n'
           '**D. 审查意见**\n'
           '\n'
           '有人为了完成B，先在WHERE加上“成绩至少84”，再按班求均分。请用两至三句话说明它为什么改变了统计口径，并说明应在哪里判断班级均分。\n'
           '\n'
           '最低交付：A明细及分类统计两条、B一条、C一条，共四条查询及本人结果；附D审查意见与至少一项交叉核验。D不强制再输入第五条完整查询。\n'
           '\n'
           '**可选挑战：**在不修改数据的前提下运行被审查的查询，与正确结果对照，并指出是哪几条原始成绩被提前排除。\n'
           '\n'
           '**需教学徒的关键点：**同范围、分类统计粒度、WHERE与HAVING、比较方向、结论证据。第4课为累计综合任务，难度与前三次不同，不把它的原始耗时直接解释为能力变化。',
  'points': ['成果拆解与各自来源', '学籍范围分类及显示', '分类汇总交叉核验', '班级统计与HAVING', '跨班比较方向及ALL', '统计口径审查与证据'],
  'checks': ['这份报告分别从哪些表产生哪些成果？',
             '学籍组合条件、类别和日期显示应怎样与需求对应？',
             '分类人数之和为什么应与同范围明细行数一致？',
             'K01班级均分至少84应该判断哪个层次？',
             '严格低于参照班全部成绩时，怎样逐值检查？',
             '先在WHERE排除低分改变了什么？请用数据检查我的理解。']},
 {'id': 'P0',
  'title': '准备课：学生基本信息展示与提交演练',
  'pages': '准备课流程演示：选列、运行、教学徒与提交',
  'brief': '**情境：**你需要协助教务老师查看教学库中的学生基本信息，并把查询思路讲给一位刚接触SQL的虚拟学徒。\n'
           '\n'
           '**阶段A——先教学徒：**解释如何显示学生姓名、所属班级编号和职务；说明数据来自哪张表、每行和每列代表什么。请学徒复述，至少检查一次其解释，指出一个正确点、遗漏点或错误点并给理由。不要求一定发生错误。\n'
           '\n'
           '**阶段B——独立完成：**关闭学徒，在SSMS中显示学生姓名、职务和入学日期，结果列按此顺序排列。本任务不要求筛选、排序或统计。保存并提交本人SQL、本人运行结果，以及一句核验说明。\n'
           '\n'
           '**提交清单：**\n'
           '\n'
           '- [ ] 我的SQL文本。\n'
           '- [ ] 本人实际执行的结果文本或按统一要求提交的结果图。\n'
           '- [ ] 核验说明：结果是否有要求的三列，顺序是否正确，是否来自学生表。\n'
           '- [ ] 已点击确认提交，并检查阶段或完成提示。\n'
           '\n'
           '**核验说明示例句式：**“我检查了结果表头，依次为……；我用……确认它来自学生表。”学生应按实际结果填写，不复制空泛结论。',
  'points': ['查询目标', '学生表来源', '输出列与顺序', '每行含义', '本人运行与核验', '提交与测评流程'],
  'checks': ['老师，今天需要显示什么基本信息？',
             '这些信息来自哪张表？',
             'SELECT中的列按什么顺序写，结果就怎样显示？',
             '结果的一行代表什么，少显示一列会删除原字段吗？',
             '请用你实际运行的结果检查我的复述。',
             '独立操作后要提交哪些材料，怎样确认已提交？']}]
PREPARATION_TIMING = {'demonstration_minutes': 10, 'reading_minutes': 5, 'reflection_minutes': 5, 'baseline_minutes': 15, 'teaching_seconds': 900, 'practice_seconds': 1200, 'quiz_seconds': 600}
FORMAL_TIMING = {'demonstration_minutes':15,'reading_minutes':5,'reflection_minutes':5,'teaching_seconds':1200,'practice_seconds':1500,'quiz_seconds':600}

def lesson_label(i):
    return '准备课P0' if i == PREPARATION_LESSON else '正式第%d课' % (i + 1)

def course_order(p):
    return p.get('course_order', COURSE_ORDER)

def next_lesson(p):
    completed = {r['index'] for r in p['rounds']}
    return next((i for i in course_order(p) if i not in completed), None)

def upgrade_config(config):
    cfg = copy.deepcopy(config)
    if cfg.get('scheme_version') != SCHEME_VERSION or cfg.get('dataset_version') != 'script-sql-20261110':
        cfg.update(FORMAL_TIMING)
        cfg.update(scheme_version=SCHEME_VERSION, dataset_version='script-sql-20261110', sequence_policy='teaching-practice-quiz', tasks=copy.deepcopy(TASKS),
                   preparation_timing=copy.deepcopy(PREPARATION_TIMING))
        cfg['prompts']['lessons'] = [t['brief'] for t in TASKS]
        cfg['prompts']['preparation'] = PREPARATION_POLICY
        cfg['prompt_version'] = cfg.get('prompt_version', 0) + 1
        # Never carry an old task's open switch into a different workorder.
        for cls in cfg['schedules']:
            cfg['schedules'][cls] = {k: {'mode':'auto' if k.startswith('practice') else 'closed','open_at':None,'close_at':None}
                for k in ['pretest','meta_pre','meta_post'] + [s+str(i) for i in COURSE_ORDER for s in ('ai','practice','posttest')]}
    if 'classes' not in cfg:
        cfg['classes_version'] = 1
        cfg['classes'] = [{'code':'2531','label':'2531','planned_size':31,'enabled':True}, {'code':'2532','label':'2532','planned_size':38,'enabled':True}]
        for c in cfg['classes']:
            cfg['schedules'].setdefault(c['code'], {k:{'mode':'auto' if k.startswith('practice') else 'closed','open_at':None,'close_at':None}
                for k in ['pretest','meta_pre','meta_post'] + [s+str(i) for i in COURSE_ORDER for s in ('ai','practice','posttest')]})
    return cfg

def upgrade_participant(p, at):
    if p.get('scheme_version') == SCHEME_VERSION:
        return False
    if p.get('rounds') and all(r.get('scheme_version') == SCHEME_VERSION for r in p['rounds']):
        p['scheme_version'] = SCHEME_VERSION
        return True
    if p.get('rounds') or p.get('meta_post'):
        snapshot = copy.deepcopy({k:v for k,v in p.items() if k not in ('session_hash','scheme_history')})
        p.setdefault('scheme_history', []).append({'archived_at':at,'scheme_version':p.get('scheme_version','legacy-three-formal/1'),'record':snapshot})
        p['prior_scheme_exposure'] = any(r.get('messages') for r in p.get('rounds',[]))
        p['rounds'] = []
        p['meta_post'] = None
        p.pop('test_lesson_control', None)
        p.get('measurement_drafts',{}).pop('meta_post',None)
        p.get('measurement_starts',{}).pop('meta_post',None)
        # Preserve baseline provenance; do not fabricate a new measurement.
        p['baseline_reused_from_legacy'] = bool(p.get('pretest') or p.get('meta_pre'))
    p['baseline_reused_from_legacy'] = bool(p.get('pretest') or p.get('meta_pre'))
    p.update(scheme_version=SCHEME_VERSION, course_order=COURSE_ORDER.copy())
    p.setdefault('events', []).append({'at':at,'type':'scheme_activated','scheme_version':SCHEME_VERSION})
    return True
