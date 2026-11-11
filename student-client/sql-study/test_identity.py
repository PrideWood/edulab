"""Reserved testing names; keep in sync with the cloud classifier."""
import re,unicodedata
PATTERN=r'^(?:柴博泉|测试|test|ceshi)(?:[\s_-]*[0-9]+)?$'
def is_test_name(name):return bool(re.fullmatch(PATTERN,unicodedata.normalize('NFKC',str(name or '')).strip().lower()))
def is_test_identity(p):return bool(is_test_name(p.get('name')) or p.get('test_identity') or p.get('test_lesson_control'))
