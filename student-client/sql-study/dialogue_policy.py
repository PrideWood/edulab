"""Minimum successful exchanges, without upper bounds or mandatory duration."""
import copy
POLICY='min10-advisory/1'
MINIMUM_TURNS=10

def completed_turns(r):
    return sum(q.get('status')=='completed' and not q.get('closing') for q in r.get('requests',[]))

def upgrade_round(r,now):
    if r.get('dialogue_policy')==POLICY or r.get('practice_start') is not None:return False
    r['dialogue_policy']=POLICY;r['timing_policy']='advisory/1'
    old=copy.deepcopy(r.get('dialogue_end'));n=completed_turns(r)
    if old and (n<MINIMUM_TURNS or (old.get('reason') in ('time_limit','turn_limit','closing_period') and not r.get('mental_effort'))):
        r.setdefault('dialogue_policy_history',[]).append({'at':now,'dialogue_end':old,'teaching_end':r.get('teaching_end'),'mental_effort':copy.deepcopy(r.get('mental_effort'))})
        r.pop('dialogue_end',None);r.pop('teaching_end',None)
        if n<MINIMUM_TURNS:r.pop('mental_effort',None)
    return True
