#!/usr/bin/env python3
"""Configure the HTTPS SWR mirror copied from the Huawei Cloud console."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from uuid import uuid4


def normalize_mirror(value):
    parsed = urlsplit(value.strip())
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment
            or not re.fullmatch(r'(?:[a-z0-9-]+\.)?mirror\.swr\.myhuaweicloud\.com', host)):
        raise ValueError('请输入华为云 SWR 控制台提供的 HTTPS 镜像加速地址')
    return 'https://' + host


def validate_daemon(candidate):
    result = subprocess.run(['dockerd', '--validate', '--config-file', str(candidate)],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError('Docker 配置校验失败，原配置未修改；请在服务器核对 dockerd 配置')


def configure(config, mirror, validate=validate_daemon):
    mirror = normalize_mirror(mirror)
    if config.is_symlink():
        raise ValueError('daemon.json 是符号链接，请由管理员核对后配置')
    original = config.read_bytes() if config.exists() else None
    settings = json.loads(original.decode('utf-8')) if original is not None else {}
    if not isinstance(settings, dict):
        raise ValueError('daemon.json 必须是 JSON 对象，原配置未修改')
    settings['registry-mirrors'] = [mirror]
    config.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.member-docker-mirror-', suffix='.json', dir=config.parent)
    candidate = Path(name)
    backup = None
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(settings, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.chmod(candidate, 0o600)
        validate(candidate)
        if config.is_symlink() or (config.read_bytes() if config.exists() else None) != original:
            raise ValueError('配置在准备期间已变化，取消写入，请重新核对')
        if original is not None:
            backup = config.with_name(config.name + '.member-backup-' + uuid4().hex)
            descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(original)
        os.replace(candidate, config)
        return backup
    finally:
        if candidate.exists():
            candidate.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mirror', nargs='?', help='HTTPS SWR mirror address')
    arguments = parser.parse_args()
    if hasattr(os, 'geteuid') and os.geteuid() != 0:
        parser.exit(1, '请使用 sudo 或 root 运行。\n')
    try:
        address = arguments.mirror or input('华为云 SWR HTTPS 镜像加速地址：').strip()
        backup = configure(Path('/etc/docker/daemon.json'), address)
        print('镜像加速地址已配置；其余 Docker 配置已保留。')
        if backup:
            print('原配置备份：' + str(backup))
        print('尚未重启 Docker。请先检查现有容器，再重启并测试镜像拉取。')
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.exit(1, str(error) + '\n')
