"""Validate BoxSpec specification examples. This does not test a running application.

Usage: python -m pip install -r tools/requirements.txt
       python tools/validate_spec.py
"""
from __future__ import annotations
import copy
import json
from pathlib import Path
from typing import Any
try:
    from jsonschema import Draft202012Validator
    from jsonschema.exceptions import ValidationError
except ImportError as exc:
    raise SystemExit('Install the pinned tools/requirements.txt dependencies first.') from exc
ROOT = Path(__file__).resolve().parents[1]

def read(rel: str) -> Any:
    return json.loads((ROOT / rel).read_text(encoding='utf-8'))

def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)

def semantic(contract: dict[str, Any]) -> None:
    nodes = contract['nodes']
    index = {n['id']: n for n in nodes}
    require(len(index) == len(nodes), 'duplicate node ID')
    root = contract['rootNodeId']
    require(root in index, 'root missing')
    require(index[root]['parentId'] is None, 'root parent must be null')
    require(sum(n['parentId'] is None for n in nodes) == 1, 'exactly one root required')
    unit = {'web-react':'css-px','unity-ugui':'canvas-unit','react-native-android':'dp'}[contract['target']]
    require(contract['coordinateSpace']['unit'] == unit, 'target/unit mismatch')
    bps = sorted(contract['breakpoints'], key=lambda b:b['minWidth'])
    bpids = {b['id'] for b in bps}
    require(len(bpids) == len(bps), 'duplicate breakpoint ID')
    require(bps[0]['minWidth'] == 0, 'breakpoints must start at zero')
    for i, b in enumerate(bps):
        hi = b['maxWidthExclusive']
        require(hi is None or hi > b['minWidth'], 'empty/inverted breakpoint')
        if i < len(bps)-1:
            require(hi is not None and hi == bps[i+1]['minWidth'], 'breakpoint overlap or gap')
        else:
            require(hi is None, 'last breakpoint must be open-ended')
    order_keys = set()
    for n in nodes:
        if n['id'] != root:
            require(n['parentId'] in index, 'missing parent')
            require(index[n['parentId']]['layout']['mode'] != 'leaf', 'leaf cannot contain child')
        seen = set()
        cur = n['id']
        while cur is not None:
            require(cur not in seen, 'cycle')
            seen.add(cur)
            cur = index[cur]['parentId']
        key = (n['parentId'], n['order'])
        require(key not in order_keys, 'duplicate sibling order')
        order_keys.add(key)
        for axis in ('width','height'):
            size = n['layout'][axis]
            if 'max' in size:
                require(size['max'] >= size.get('min',0), 'inverted sizing range')
        if n['layout']['mode'] == 'grid':
            require('gridColumns' in n['layout'], 'grid columns required')
        for override in n['responsive']:
            require(override['breakpointId'] in bpids, 'unknown responsive breakpoint')
        require(len({x['breakpointId'] for x in n['responsive']}) == len(n['responsive']), 'duplicate node override')
        for lock in n['locks']:
            curval: Any = n
            for token in lock['path'].strip('/').split('/'):
                token = token.replace('~1','/').replace('~0','~')
                require(isinstance(curval, dict) and token in curval, 'lock path does not exist')
                curval = curval[token]
            if lock['policy'] == 'soft':
                require(isinstance(curval,(int,float)) and not isinstance(curval,bool), 'soft lock must target number')
                require(lock['min'] <= lock['max'], 'inverted soft range')
                require(lock['min'] <= curval <= lock['max'], 'current value outside soft range')
    fixtures = set(contract['verification']['fixtureIds'])
    for a in contract['assertions']:
        require(a['nodeId'] in index, 'assertion node missing')
        if 'otherNodeId' in a:
            require(a['otherNodeId'] in index, 'assertion other node missing')
        require(set(a.get('when',{}).get('breakpointIds',[])) <= bpids, 'unknown assertion breakpoint')
        require(set(a.get('when',{}).get('fixtureIds',[])) <= fixtures, 'unknown assertion fixture')
    require(len({a['id'] for a in contract['assertions']}) == len(contract['assertions']), 'duplicate assertion ID')

def check_metrics(contract: dict[str,Any], metrics: dict[str,Any]) -> list[str]:
    """Small assertion evaluator for hand-authored fixtures, NOT the production geometry engine."""
    require(metrics['origin']=='hand-authored-spec-fixture-not-runtime-evidence', 'metrics origin marker changed')
    viewport = next(v for v in contract['verification']['viewports'] if v['id']==metrics['viewportId'])
    bp = next(b for b in contract['breakpoints'] if b['minWidth']<=viewport['width'] and
              (b['maxWidthExclusive'] is None or viewport['width']<b['maxWidthExclusive']))['id']
    failures = []
    for a in contract['assertions']:
        when = a.get('when',{})
        if when.get('breakpointIds') and bp not in when['breakpointIds']:
            continue
        if when.get('fixtureIds') and metrics['fixtureId'] not in when['fixtureIds']:
            continue
        m = metrics['nodes'].get(a['nodeId'])
        passed = m is not None
        if not passed:
            failures.append(a['id']);continue
        if a['kind']=='numeric':
            x,e,t=m[a['metric']],a['expected'],a['tolerance']
            passed=m['visible'] and {'eq':abs(x-e)<=t,'gte':x>=e-t,'lte':x<=e+t}[a['operator']]
        elif a['kind']=='visibility':
            passed=m['visible']==a['expected']
        elif a['kind']=='overflow':
            if a['allowed']!='none':
                raise ValueError('Spec fixture evaluator only supports overflow=none; not a full renderer')
            passed=m['visible'] and not ((a['axis'] in ('x','both') and m['overflowX']) or
                                        (a['axis'] in ('y','both') and m['overflowY']))
        elif a['kind']=='relation':
            other=metrics['nodes'].get(a['otherNodeId'])
            passed=other is not None and m['visible'] and other['visible']
            if passed:
                rel,gap,t=a['relation'],a['gap'],a['tolerance']
                if rel=='right-of':passed=abs(m['left']-other['right']-gap)<=t
                elif rel=='below':passed=abs(m['top']-other['bottom']-gap)<=t
                elif rel=='aligned-left':passed=abs(m['left']-other['left'])<=t
                elif rel=='aligned-top':passed=abs(m['top']-other['top'])<=t
                elif rel=='inside':passed=(m['left']>=other['left']+gap-t and m['top']>=other['top']+gap-t and
                                         m['right']<=other['right']-gap+t and m['bottom']<=other['bottom']-gap+t)
        if not passed:failures.append(a['id'])
    return failures

def main() -> None:
    schema=read('contracts/layout-contract.schema.json')
    Draft202012Validator.check_schema(schema)
    Draft202012Validator.check_schema(read('contracts/context-slice.schema.json'))
    validator=Draft202012Validator(schema)
    contract=read('examples/dashboard.contract.json')
    validator.validate(contract);semantic(contract)
    results=['layout schema and valid contract: PASS']
    invalid_cases={
        'cycle':lambda c:c['nodes'][4].update(parentId='search'),
        'missing parent':lambda c:c['nodes'][4].update(parentId='absent'),
        'breakpoint overlap':lambda c:c['breakpoints'][1].update(minWidth=700),
        'duplicate node':lambda c:c['nodes'].append(copy.deepcopy(c['nodes'][0])),
        'invalid soft range':lambda c:c['nodes'][4]['locks'].append({'path':'/layout/gap','policy':'soft','min':30,'max':10}),
        'unknown property':lambda c:c.update(silentUnexpectedField=True),
        'wrong unit':lambda c:c['coordinateSpace'].update(unit='dp'),
    }
    for label, mutate in invalid_cases.items():
        bad=copy.deepcopy(contract);mutate(bad)
        try:validator.validate(bad);semantic(bad)
        except (ValidationError, ValueError):results.append(f'negative contract: {label}: correctly rejected')
        else:raise AssertionError(f'invalid contract accepted: {label}')
    for filename in ['metrics.desktop.pass.json','metrics.compact.pass.json']:
        failures=check_metrics(contract,read('examples/'+filename))
        require(not failures, f'{filename}: unexpected violations {failures}')
        results.append(f'hand-authored geometry fixture {filename}: PASS')
    failures=check_metrics(contract,read('examples/metrics.desktop.fail.json'))
    require('sidebar-width' in failures and 'main-next-sidebar' in failures,'negative geometry not rejected')
    results.append('hand-authored 320px sidebar negative fixture: correctly rejected')
    tools=read('contracts/mcp-tools.json')['tools']
    require(len({t['name'] for t in tools})==len(tools),'duplicate tool names')
    for tool in tools:
        Draft202012Validator.check_schema(tool['inputSchema'])
        Draft202012Validator.check_schema(tool['outputSchema'])
        Draft202012Validator(tool['outputSchema']).validate({'ok':False,'code':'APP_NOT_RUNNING',
               'message':'Specification validation example','recoverable':True,'requestId':'example-0001'})
    index={t['name']:t for t in tools}
    for name,file in [('boxspec_get_context','task-context.example.json'),('boxspec_start_task','start-task.example.json')]:
        Draft202012Validator(index[name]['inputSchema']).validate(read('examples/'+file))
    # Reject a primary security regression even if it looks like ordinary text edits.
    require(not any(t['name'] in ('boxspec_approve','boxspec_apply_to_main','boxspec_run_shell','boxspec_unlock') for t in tools),
            'privileged human-only tool exposed')
    results.append(f'{len(tools)} MCP tool input/output schemas and request examples: PASS')
    for json_path in ROOT.rglob('*.json'):
        json.loads(json_path.read_text(encoding='utf-8'))
    results.append('all JSON files parse: PASS')
    report={
        'scope':'Specification/static fixtures only. No application, renderer, live MCP client or security implementation tested.',
        'results':results,'runtimeProductVerified':False
    }
    (ROOT/'SPEC_VALIDATION_REPORT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('\n'.join(results))
    print(report['scope'])

if __name__=='__main__':
    main()
