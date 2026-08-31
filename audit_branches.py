import subprocess
import sys
import os

def run_cmd(cmd):
    try:
        p = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return p.stdout.decode('utf-8', errors='ignore')
    except Exception:
        return ""

branches = [
    ("origin/main", "5a3e47d2993ac49738b7a4252d1c3aa43812fe37"),
    ("origin/arena/019f94a7-jata-qi", "5610b8f949c447ab6011b789625b5ced5c699c30"),
    ("origin/arena/019fccab-jata-qi", "8348cec96a565874c59336259c3ec03ee7c1e0f3"),
    ("arena/01a04e8b-jata-qi", "b7687fe9ac7a4c9d970ef6a03ee43f621148bdd1")
]

for name, sha in branches:
    print(f"======================================")
    print(f"Branch: {name} (SHA: {sha})")
    print(f"======================================")
    
    files_output = run_cmd(f"git ls-tree -r --name-only {sha}")
    files = [f.strip() for f in files_output.splitlines() if f.strip()]
    
    valid_files = []
    for f in files:
        if '.git' in f or 'node_modules' in f or '/dist/' in f or f.startswith('dist/') or '__pycache__' in f or f.endswith('.pyc') or f.endswith('.png') or f.endswith('.jpg'):
            continue
        valid_files.append(f)
        
    total_files = len(valid_files)
    source_files = 0
    test_files = 0
    doc_files = 0
    config_files = 0
    
    ts_loc = 0
    js_loc = 0
    py_loc = 0
    sql_loc = 0
    sh_loc = 0
    json_conf_loc = 0
    
    total_loc = 0
    source_loc_ex_tests = 0
    test_loc = 0
    blank_lines = 0
    comment_lines = 0
    
    packages = set()
    test_count = 0
    
    for f in valid_files:
        parts = f.split('/')
        if len(parts) > 1 and parts[0] == 'packages':
            packages.add(parts[1])
            
        ext = os.path.splitext(f)[1].lower()
        is_test = '.test.' in f or 'test/' in f or '_test.' in f
        is_source = ext in ['.ts', '.js', '.py', '.sql', '.sh', '.mjs', '.cjs', '.tsx', '.jsx'] and not is_test
        is_doc = ext in ['.md', '.txt', '.rst'] or 'docs/' in f
        is_config = ext in ['.json', '.yaml', '.yml', '.toml', '.env', '.ini'] or f.endswith('package.json') or f.endswith('tsconfig.json')
        
        if is_test:
            test_files += 1
        elif is_source:
            source_files += 1
        if is_doc:
            doc_files += 1
        if is_config:
            config_files += 1
            
        content = run_cmd(f"git show {sha}:{f}")
        lines = content.splitlines()
        file_loc = len(lines)
        total_loc += file_loc
        
        if is_test:
            test_loc += file_loc
        elif is_source:
            source_loc_ex_tests += file_loc
            
        for line in lines:
            stripped = line.strip()
            if not stripped:
                blank_lines += 1
            elif stripped.startswith('//') or stripped.startswith('#') or stripped.startswith('/*') or stripped.startswith('*'):
                comment_lines += 1
                
        if ext in ['.ts', '.tsx']:
            ts_loc += file_loc
        elif ext in ['.js', '.mjs', '.cjs', '.jsx']:
            js_loc += file_loc
        elif ext == '.py':
            py_loc += file_loc
        elif ext == '.sql':
            sql_loc += file_loc
        elif ext == '.sh':
            sh_loc += file_loc
        elif ext in ['.json', '.yaml', '.yml', '.toml'] or 'config' in f:
            json_conf_loc += file_loc
            
        if is_test:
            for line in lines:
                if 'test(' in line or 'it(' in line or 'describe(' in line or 'def test_' in line:
                    test_count += 1
                    
    print(f"Tracked Files: {total_files}")
    print(f"Source Files: {source_files}")
    print(f"Test Files: {test_files}")
    print(f"Doc Files: {doc_files}")
    print(f"Config Files: {config_files}")
    print(f"Total LOC: {total_loc}")
    print(f"Source LOC (excl tests): {source_loc_ex_tests}")
    print(f"Test LOC: {test_loc}")
    print(f"Blank Lines: {blank_lines}")
    print(f"Comment Lines: {comment_lines}")
    print(f"TypeScript LOC: {ts_loc}")
    print(f"JavaScript LOC: {js_loc}")
    print(f"Python LOC: {py_loc}")
    print(f"SQL LOC: {sql_loc}")
    print(f"Shell LOC: {sh_loc}")
    print(f"JSON/Config LOC: {json_conf_loc}")
    print(f"Packages/Workspaces: {len(packages)}")
    print(f"Test Suites/Files: {test_files}")
    print(f"Estimated Tests: {test_count}")
    print()
