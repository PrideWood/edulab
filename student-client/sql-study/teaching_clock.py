"""Foreground-only teaching time with short presence leases; no browser clock trust."""
import copy
POLICY='foreground-active/1'
LEASE_SECONDS=4

def ensure_clock(r,now):
    if r.get('teaching_start') is None or r.get('practice_start') is not None or r.get('teaching_clock') is not None:return False
    duration=r['config']['teaching_seconds']
    r['previous_teaching_window']={**r.get('previous_teaching_window',{}),'policy':r.get('teaching_window_policy'),'deadline':r.get('teaching_deadline'),'dialogue_end':copy.deepcopy(r.get('dialogue_end')),'prior_wall_elapsed':max(0,now-r['teaching_start'])}
    finished=bool(r.get('mental_effort'))
    r['teaching_clock']={'version':POLICY,'elapsed_seconds':duration if finished else 0,'accounted_at':now,'active_until':now,'view_id':None,'sequences':{},'legacy_elapsed_unknown':r.get('teaching_window_policy')!=POLICY}
    r['teaching_window_policy']=POLICY
    if not finished and (r.get('dialogue_end') or {}).get('reason') in ('time_limit','closing_period'):
        r.pop('dialogue_end',None);r.pop('teaching_end',None)
    tick_clock(r,now)
    return True

def tick_clock(r,now):
    c=r.get('teaching_clock')
    if c is None or r.get('practice_start') is not None:return False
    before=(c['elapsed_seconds'],c['accounted_at'],r.get('teaching_deadline'))
    duration=r['config']['teaching_seconds']
    elapsed=max(0,min(now,c['active_until'])-c['accounted_at'])
    c['elapsed_seconds']=min(duration,c['elapsed_seconds']+elapsed)
    c['accounted_at']=max(now,c['accounted_at'])
    r['teaching_deadline']=now+max(0,duration-c['elapsed_seconds'])
    return before!=(c['elapsed_seconds'],c['accounted_at'],r['teaching_deadline'])

def presence(r,now,active,view_id,sequence):
    c=r['teaching_clock'];previous=c['sequences'].get(view_id,-1)
    if sequence<=previous:return False
    tick_clock(r,now);c['sequences'][view_id]=sequence
    if len(c['sequences'])>24:
        c['sequences']={view_id:sequence,**({c['view_id']:c['sequences'].get(c['view_id'],0)} if c['view_id'] else {})}
    if active:
        c['view_id']=view_id;c['active_until']=now+LEASE_SECONDS
    elif c['view_id'] in (None,view_id):c['active_until']=now
    return True

def status(r,now):
    c=r.get('teaching_clock')
    if c is None:return {}
    remaining=max(0,r['config']['teaching_seconds']-c['elapsed_seconds'])
    return {'foreground_clock':True,'timer_running':remaining>0 and now<c['active_until'],'timer_elapsed_seconds':c['elapsed_seconds'],'timer_remaining_seconds':remaining,'timer_lease_until':c['active_until'],'timer_policy':POLICY}
