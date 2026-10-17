"""Prepare narrow patches from live snapshots; never print credentials."""
import copy
import json
from pathlib import Path
import re
import sys

OLD = 'aigcbackend.boschhuayu-steering.com'
NEW = 'aigcplatform.boschhuayu-steering.com'
SECRET = 'aigc-platform-tls'


def server_blocks(text):
    blocks = []
    for match in re.finditer(r'(?m)^\s*server\s*\{', text):
        start = text.index('server', match.start())
        brace = text.index('{', start)
        depth, quote, comment, escaped = 0, None, False, False
        for index in range(brace, len(text)):
            char = text[index]
            if comment:
                if char == '\n': comment = False
                continue
            if quote:
                if escaped: escaped = False
                elif char == '\\': escaped = True
                elif char == quote: quote = None
                continue
            if char == '#': comment = True
            elif char in ['"', "'"]: quote = char
            elif char == '{': depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    blocks.append((start, index + 1, text[start:index + 1]))
                    break
        else:
            raise ValueError('Unbalanced nginx server block')
    return blocks


def dual_tls(text, port, browser_redirect=False):
    if '/etc/nginx/tls-platform/' in text:
        raise ValueError('New certificate configuration already exists; inspect instead of applying twice')
    candidates = [(a,b,c) for a,b,c in server_blocks(text)
                  if re.search(r'\blisten\s+' + str(port) + r'\s+ssl\b',c)]
    if len(candidates) != 1:
        raise ValueError('Expected one TLS server on port ' + str(port))
    start,end,original = candidates[0]
    if re.search(r'\bserver_name\s+[^;]*'+re.escape(NEW),original):
        raise ValueError('New hostname already exists in old TLS server; inspect first')
    if '/etc/nginx/tls/tls.crt' not in original or '/etc/nginx/tls/tls.key' not in original:
        raise ValueError('TLS paths differ from runbook')
    new, count = re.subn(r'\bserver_name\s+[^;]+;', 'server_name ' + NEW + ';', original)
    if count != 1:
        raise ValueError('Expected one server_name in TLS server')
    new = new.replace('/etc/nginx/tls/', '/etc/nginx/tls-platform/')
    old = original
    if browser_redirect:
        old, count = re.subn(r'\blocation\s+/\s*\{', lambda m: m.group(0)
                             + '\n        return 308 https://' + NEW + '$request_uri;', old)
        if count != 1:
            raise ValueError('Expected one browser root location')
    text = text[:start] + old + text[end:]
    # HTTP can accept both hosts; retain all original HTTP routing.
    if browser_redirect:
        for a,b,block in reversed(server_blocks(text)):
            if re.search(r'\blisten\s+80\s*;',block):
                block=re.sub(r'\bserver_name\s+([^;]+);',lambda m:'server_name '+m.group(1).strip()
                             +(' '+NEW if OLD in m.group(1).split() and NEW not in m.group(1).split() else '')+';',block)
                text=text[:a]+block+text[b:]
    return text.rstrip() + '\n\n' + new + '\n'


def deployment_patch(spec):
    return {'spec': {'template': {'spec': spec}}}


def prepare(root):
    root = Path(root)
    def read(name): return json.loads((root / (name + '.json')).read_text())
    def write(name, obj): (root / name).write_text(json.dumps(obj, indent=2))
    release = json.loads((Path(__file__).parent / 'release.json').read_text())
    deployments = {n: read(n+'-deployment') for n in ['aigc-api','aigc-portal','aigc-edge','nj304-litellm-proxy']}
    for name, obj in deployments.items():
        spec = obj['spec']['template']['spec']
        if spec.get('nodeSelector',{}).get('kubernetes.io/hostname') != release['node']:
            raise ValueError(name + ': nodeSelector differs from runbook')
        for container in spec['containers']:
            if name in ['aigc-api','aigc-portal'] and container.get('imagePullPolicy') != 'Never':
                raise ValueError(name + ': expected imagePullPolicy Never for offline deployment')
    settings = read('aigc-settings')['data']
    effective = dict(settings)
    api_spec = deployments['aigc-api']['spec']['template']['spec']
    api = next(c for c in api_spec['containers'] if c['name']=='api')
    if not any(s.get('configMapRef',{}).get('name')=='aigc-settings' and not s.get('prefix') for s in api.get('envFrom',[])):
        raise ValueError('API must consume aigc-settings')
    # Refuse unknown override sources rather than guessing effective origins.
    for source in api.get('envFrom',[]):
        name = source.get('configMapRef',source.get('secretRef',{})).get('name')
        if source.get('prefix') or name not in ['aigc-settings','aigc-secrets']:
            raise ValueError('Inspect additional API envFrom source before switching')
    import base64
    for key,value in read('aigc-secrets').get('data',{}).items():
        if key.startswith(('Cas__','Cors__Origins__','LiteLlm__PublicBaseUrl')):
            effective[key] = base64.b64decode(value).decode()
    for item in api.get('env',[]):
        if item['name'].startswith(('Cas__','Cors__Origins__','LiteLlm__PublicBaseUrl')):
            if 'valueFrom' in item: raise ValueError('Indirect domain environment override: '+item['name'])
            effective[item['name']] = item.get('value','')
    desired = {'Cas__PublicBaseUrl':'https://'+NEW, 'Cas__PortalBaseUrl':'https://'+NEW,
               'Cas__ServiceUrl':'https://'+NEW+'/v1/auth/cas/callback'}
    origins={k:v for k,v in effective.items() if re.fullmatch(r'Cors__Origins__\d+',k)}
    for host in [NEW,OLD]:
        if 'https://'+host not in origins.values():
            index=max([int(k.rsplit('__',1)[1]) for k in origins]+[-1])+1
            origins['Cors__Origins__'+str(index)]='https://'+host
    desired.update(origins)
    public=effective.get('LiteLlm__PublicBaseUrl','')
    if re.match(r'https://'+re.escape(OLD)+r'(?=[:/]|$)',public):
        desired['LiteLlm__PublicBaseUrl']=public.replace(OLD,NEW,1)
    for name in ['aigc-settings','aigc-edge-nginx','nj304-litellm-proxy']:
        obj=read(name)
        write(name+'-restore.json',[{'op':'replace','path':'/data','value':obj['data']}])
    write('settings-apply.json',{'data':desired})
    for cm,port,redirect in [('aigc-edge-nginx',443,True),('nj304-litellm-proxy',8443,False)]:
        text=dual_tls(read(cm)['data']['default.conf'],port,redirect)
        write(cm+'-apply.json',{'data':{'default.conf':text}})
        (root/(cm+'-check.conf')).write_text('events {}\nhttp {\n'+text.replace('/etc/nginx/tls-platform/','/etc/nginx/tls/')+'\n}\n')
    for name,obj in deployments.items():
        spec=obj['spec']['template']['spec']
        container_name={'aigc-api':'api','aigc-portal':'portal'}.get(name,'nginx')
        container=next(c for c in spec['containers'] if c['name']==container_name)
        restore=copy.deepcopy(container)
        # Restore only modified fields; keep probes/resources/other container state out of patches.
        fields=['image','imagePullPolicy','env'] if name in ['aigc-api','aigc-portal'] else ['volumeMounts']
        restore={'name':container_name,**{k:copy.deepcopy(container[k]) for k in fields if k in container}}
        if name=='aigc-api':
            restore['env']=[{'$patch':'replace'},*container.get('env',[])]
            apply={'name':'api','image':release['apiImage'],'env':[{'$patch':'replace'},
                   *[e for e in container.get('env',[]) if e['name'] not in desired],
                   *[{'name':k,'value':v} for k,v in desired.items()]]}
            new_spec={'containers':[apply]}
            old_spec={'containers':[restore]}
        elif name=='aigc-portal':
            new_spec={'containers':[{'name':'portal','image':release['portalImage']}]}
            old_spec={'containers':[restore]}
        else:
            volumes=spec.get('volumes',[])
            mounts=container.get('volumeMounts',[])
            if not any(v.get('secret',{}).get('secretName')=='aigc-edge-tls' for v in volumes):
                raise ValueError(name+': old certificate Secret differs from runbook')
            if any(v['name']=='tls-platform' for v in volumes) or any(m['mountPath']=='/etc/nginx/tls-platform' for m in mounts):
                raise ValueError(name+': new TLS volume already exists')
            new_spec={'volumes':[{'name':'tls-platform','secret':{'secretName':SECRET}}],
                      'containers':[{'name':container_name,'volumeMounts':[{'name':'tls-platform','mountPath':'/etc/nginx/tls-platform','readOnly':True}]}]}
            restore['volumeMounts']=[{'$patch':'replace'},*mounts]
            old_spec={'volumes':[{'$patch':'replace'},*volumes],'containers':[restore]}
        write(name+'-deployment-apply.json',deployment_patch(new_spec))
        write(name+'-deployment-restore.json',deployment_patch(old_spec))
    write('switch-state.json',{'namespace':release['namespace'],'newSecret':SECRET,
          'publicModelEndpoint':desired.get('LiteLlm__PublicBaseUrl',public)})
    print('Prepared live-config patches; upstreams and existing CORS entries retained; old TLS Secret untouched.')


if __name__=='__main__':
    prepare(sys.argv[1])
