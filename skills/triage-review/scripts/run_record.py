#!/usr/bin/env python3
"""Resolve one skill record and reject a resume from an unrelated repository."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def resolve(repo, skill, slug=None, record=None, resume=False):
    repo = Path(git(repo, 'rev-parse', '--show-toplevel')).resolve()
    common = Path(git(repo, 'rev-parse', '--git-common-dir'))
    if not common.is_absolute():
        common = repo / common
    common = common.resolve()
    roots = sorted(git(repo, 'rev-list', '--max-parents=0', 'HEAD').splitlines())
    identity = hashlib.sha256(json.dumps([str(common), roots], separators=(',', ':')).encode()).hexdigest()
    if record:
        destination = Path(record)
        if not destination.is_absolute():
            destination = repo / destination
    else:
        if resume or not slug or '/' in slug or '\\' in slug or slug in {'.', '..'}:
            raise ValueError('a new run needs a safe date-slug; resume needs the retained RECORD path')
        destination = common / ('triage' if skill == 'triage-review' else 'plan') / slug
    destination = destination.resolve()
    manifest = destination / 'run-identity.json'
    value = {'version': 1, 'skill': skill, 'record': str(destination), 'primaryAtCreation': str(repo),
             'commonDirectory': str(common), 'repositoryIdentity': identity, 'rootCommits': roots}
    if manifest.exists():
        prior = json.loads(manifest.read_text())
        if prior.get('repositoryIdentity') != identity or prior.get('commonDirectory') != str(common):
            raise ValueError('RECORD belongs to a different repository; basename/slug is not identity')
        # A plan continues a triage run without changing ownership or its retained path.
        return prior
    if resume:
        raise ValueError('resume has no run identity; inspect legacy record ownership before adopting it')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('nonempty legacy RECORD has no identity; do not silently adopt it')
    destination.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(value, indent=2) + '\n')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--skill', choices=['triage-review', 'ez-plan'], required=True)
    parser.add_argument('--slug')
    parser.add_argument('--record', help='explicit skill-specific destination, or retained absolute RECORD on resume')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(resolve(args.repo, args.skill, args.slug, args.record, args.resume), indent=2))
    except (ValueError, subprocess.CalledProcessError, OSError, json.JSONDecodeError) as error:
        parser.exit(1, str(error) + '\n')
