# -*- coding: utf-8 -*-
"""备用推送通道：当 github.com 被阻断（TLS SNI 阻断，实测换 IP、改 hosts 均无效）时，
改用 GitHub REST API（api.github.com，实测直连 0.7s 可用）把本地提交推上去。

与直接 git push 的差别（重要）：
  · 本机 core.autocrlf=true + .gitattributes，工作区是 CRLF，git 仓库里存的是 LF。
    必须上传「git 记录的字节」(git cat-file blob)，不能上传工作区文件，
    否则远程存进去的换行与 git 记录不一致，以后每次推送都会多出假差异。
  · 用「本地 HEAD tree」与「远程 tree」逐文件比对（而不是 git diff），
    这样即使远程有本地不知道的提交也能正确算出要传哪些文件。
  · 加 --align 时，以「本地 HEAD 的父提交」为父重建提交并强制指向它。
    因为 commit 的 SHA 由 tree+parent+作者+时间+message 决定，这样 GitHub 算出的
    SHA 与本地 HEAD 完全相同 -> 本地与远程彻底对齐，不留分叉（以后 git push 也能直接跑）。
    该操作只收敛内容相同的提交，不会丢任何文件内容。

凭据：从本机 GCM 读（原生 cmd 环境 git credential fill），不落盘、不打印、不写文件。

用法：
  python push_via_api.py [--dry]          # 正常推送（以远程当前 HEAD 为父）
  python push_via_api.py --align          # 推送并把历史对齐到本地 HEAD（消除分叉）
"""
import subprocess, json, base64, os, sys, urllib.request, urllib.error

REPO = None       # 仓库根目录，运行时确定（见 _find_repo），不写死本机路径
OWNER, REPO_NAME, BRANCH = 'mosgpt-alt', 'shuimatong', 'main'
API = 'https://api.github.com'


def find_repo():
    """仓库根目录：--repo 参数 > 环境变量 ZG_REPO > 脚本所在目录（若其上级含 .git 则取上级）> 当前目录"""
    a = sys.argv
    if '--repo' in a and a.index('--repo') + 1 < len(a):
        return a[a.index('--repo') + 1]
    if os.environ.get('ZG_REPO'):
        return os.environ['ZG_REPO']
    here = os.path.dirname(os.path.abspath(__file__))
    up = os.path.dirname(here)
    if os.path.exists(os.path.join(here, '.git')):
        return here
    if os.path.exists(os.path.join(up, '.git')):
        return up
    return os.getcwd()


def run(args, strip=True):
    r = subprocess.run(['git'] + args, cwd=REPO, capture_output=True)
    s = r.stdout.decode('utf-8', 'replace')
    return s.strip() if strip else s


def get_token():
    inp = b'protocol=https\nhost=github.com\n\n'
    r = subprocess.run(['cmd.exe', '/c', 'git credential fill'], cwd=REPO,
                       input=inp, capture_output=True)
    d = {}
    for line in r.stdout.decode('utf-8', 'replace').splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            d[k.strip()] = v.strip()
    return d.get('password'), d.get('username')


def api(method, path, body=None, token=None, timeout=300):
    req = urllib.request.Request(API + path, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'shuimatong-push')
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, data, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %s %s %s -> %s' % (e.code, method, path,
                                                    e.read().decode('utf-8', 'replace')[:400]))


def local_index(rev):
    """path -> (mode, blob_sha)，用 -z 避免中文路径被转义"""
    out = subprocess.run(['git', 'ls-tree', '-r', '-z', rev], cwd=REPO, capture_output=True).stdout
    d = {}
    for rec in out.split(b'\x00'):
        if not rec:
            continue
        meta, _, path = rec.partition(b'\t')
        f = meta.decode('ascii', 'replace').split()
        if len(f) == 3 and f[1] == 'blob':
            d[path.decode('utf-8', 'replace')] = (f[0], f[2])
    return d


def remote_index(tree_sha, tok):
    t = api('GET', '/repos/%s/%s/git/trees/%s?recursive=1' % (OWNER, REPO_NAME, tree_sha), token=tok)
    d = {}
    for e in t.get('tree', []):
        if e['type'] == 'blob':
            d[e['path']] = (e['mode'], e['sha'])
    return d, bool(t.get('truncated'))


def tree_of_commit(sha, tok):
    return api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO_NAME, sha), token=tok)['tree']['sha']


def head_meta(rev):
    """取本地 commit 的原始信息（message 必须原样，末尾换行会影响 SHA）"""
    raw = run(['cat-file', 'commit', rev], strip=False)
    head_part, _, body = raw.partition('\n\n')
    who = {}
    for line in head_part.splitlines():
        k, _, v = line.partition(' ')
        who[k] = v
    fmt = run(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', rev]).split('\x00')
    return {
        'tree': who.get('tree', ''),
        'parents': [x for x in who.get('parent', '').split() if x],
        'message': body,
        'author': {'name': fmt[0], 'email': fmt[1], 'date': fmt[2]},
        'committer': {'name': fmt[3], 'email': fmt[4], 'date': fmt[5]},
    }


def main():
    global REPO
    REPO = find_repo()
    dry = '--dry' in sys.argv
    align = '--align' in sys.argv
    print('仓库: %s' % REPO)
    tok, user = get_token()
    if not tok:
        print('× 取不到 GitHub 凭据（GCM 里没有 github.com 记录）'); return 1
    print('凭据就绪：账号 %s，token %d 字节（不落盘）' % (user, len(tok)))

    rsha = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO_NAME, BRANCH), token=tok)['object']['sha']
    rtree = tree_of_commit(rsha, tok)

    lsha = run(['rev-parse', 'HEAD'])
    ltree = run(['rev-parse', 'HEAD^{tree}'])
    meta = head_meta(lsha)
    force = False

    # 已经推过了就直接收工。--align 模式下 base 是「本地 HEAD 的父提交」，
    # 若不做这个短路，即使远程已经对齐，也会再上传一遍与父提交不同的文件（幂等被破坏）。
    if rsha == lsha:
        print('√ 远程 %s 已经就是本地 HEAD（%s），无需推送' % (BRANCH, lsha[:8]))
        return 0

    if align:
        if not meta['parents']:
            print('× 本地 HEAD 没有父提交，无法对齐'); return 4
        base = meta['parents'][0]
        try:
            btree = tree_of_commit(base, tok)
        except Exception as e:
            print('× 远程没有本地 HEAD 的父提交 %s，无法对齐（%s）' % (base[:8], e)); return 4
        rsha, rtree, force = base, btree, True
        print('对齐模式：以本地父提交 %s 为基准重建提交' % base[:8])

    print('远程 %s = %s   tree = %s' % (BRANCH, rsha[:8], rtree[:8]))
    print('本地    = %s   tree = %s' % (lsha[:8], ltree[:8]))

    if ltree == rtree and not force:
        print('√ 两边内容完全一致（tree 相同）：%s' % ltree)
        return 0

    ri, trunc = remote_index(rtree, tok)
    li = local_index('HEAD')
    if trunc:
        print('× 远程 tree 太大被截断，本脚本不适用'); return 3
    print('远程文件 %d 个 / 本地 %d 个' % (len(ri), len(li)))

    upload = sorted(p for p in li if ri.get(p) != li[p])
    delete = sorted(p for p in ri if p not in li)
    print('需上传 %d 个，需删除 %d 个：' % (len(upload), len(delete)))
    for p in upload:
        print('   %s  %s' % ('改' if p in ri else '增', p))
    for p in delete:
        print('   删 %s' % p)
    if dry:
        print('（干跑，未改动远程）'); return 0

    items = []
    for p in upload:
        mode, bsha = li[p]
        blob = subprocess.run(['git', 'cat-file', 'blob', bsha], cwd=REPO, capture_output=True).stdout
        res = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO_NAME),
                  {'content': base64.b64encode(blob).decode('ascii'), 'encoding': 'base64'}, token=tok)
        items.append({'path': p, 'mode': mode, 'type': 'blob', 'sha': res['sha']})
        print('   上传 %-30s %9d 字节 mode=%s' % (p, len(blob), mode))
    for p in delete:
        items.append({'path': p, 'mode': '100644', 'type': 'blob', 'sha': None})

    tree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO_NAME),
               {'base_tree': rtree, 'tree': items}, token=tok)
    print('新 tree = %s %s' % (tree['sha'][:8], '(= 本地 HEAD tree)' if tree['sha'] == ltree else ''))

    commit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO_NAME), {
        'message': meta['message'], 'tree': tree['sha'], 'parents': [rsha],
        'author': meta['author'], 'committer': meta['committer'],
    }, token=tok)
    m1 = (meta['message'].splitlines() or [''])[0]
    print('新提交  = %s 「%s」' % (commit['sha'][:8], m1))
    if commit['sha'] == lsha:
        print('√ 与本地 HEAD 完全一致（SHA 相同），本地 / 远程不会分叉')
    else:
        print('! SHA 与本地不同（%s vs %s）：内容一致，但历史分叉' % (commit['sha'][:8], lsha[:8]))

    api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO_NAME, BRANCH),
        {'sha': commit['sha'], 'force': force}, token=tok)
    print('√ 已更新远程 %s -> %s%s' % (BRANCH, commit['sha'][:8], '（force 对齐）' if force else ''))

    if commit['sha'] == lsha:
        try:
            subprocess.run(['git', 'update-ref', 'refs/remotes/origin/%s' % BRANCH, lsha], cwd=REPO, check=True)
            print('√ 本地 origin/%s 引用已同步（对象存在，可直接对齐）' % BRANCH)
        except Exception as e:
            print('（本地引用同步失败，不影响远程：%r）' % (e,))
    return 0


if __name__ == '__main__':
    sys.exit(main())
