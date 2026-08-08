#!/usr/bin/env python3
import ctypes
import errno
import json
import os
import sys

PR_CAPBSET_DROP = 24
PR_SET_NO_NEW_PRIVS = 38
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4

DANGEROUS_CAPABILITIES = (
    12,  # CAP_NET_ADMIN
    13,  # CAP_NET_RAW
    16,  # CAP_SYS_MODULE
    17,  # CAP_SYS_RAWIO
    18,  # CAP_SYS_CHROOT
    19,  # CAP_SYS_PTRACE
    20,  # CAP_SYS_PACCT
    21,  # CAP_SYS_ADMIN
    22,  # CAP_SYS_BOOT
    25,  # CAP_SYS_TIME
    26,  # CAP_SYS_TTY_CONFIG
    27,  # CAP_MKNOD
    30,  # CAP_AUDIT_CONTROL
    31,  # CAP_SETFCAP
    32,  # CAP_MAC_OVERRIDE
    33,  # CAP_MAC_ADMIN
    34,  # CAP_SYSLOG
    35,  # CAP_WAKE_ALARM
    36,  # CAP_BLOCK_SUSPEND
    37,  # CAP_AUDIT_READ
    38,  # CAP_PERFMON
    39,  # CAP_BPF
    40,  # CAP_CHECKPOINT_RESTORE
)


def prctl(option, argument):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(option, argument, 0, 0, 0) == 0:
        return
    error = ctypes.get_errno()
    if error != errno.EINVAL:
        raise OSError(error, os.strerror(error))


def parse_payload(value):
    payload = json.loads(value)
    if not isinstance(payload, dict):
        raise ValueError("launcher payload must be an object")
    command = payload.get("command")
    cwd = payload.get("cwd")
    environment = payload.get("environment")
    if not isinstance(command, str) or not command:
        raise ValueError("launcher command is invalid")
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        raise ValueError("launcher working directory is invalid")
    if not isinstance(environment, dict):
        raise ValueError("launcher environment is invalid")
    normalized_environment = {}
    for key, entry in environment.items():
        if not isinstance(key, str) or not key or "=" in key or "\0" in key:
            raise ValueError("launcher environment key is invalid")
        if not isinstance(entry, str) or "\0" in entry:
            raise ValueError("launcher environment value is invalid")
        normalized_environment[key] = entry
    return command, cwd, normalized_environment


def main():
    if len(sys.argv) != 3:
        raise ValueError("launcher requires a sandbox root and payload")
    command, cwd, environment = parse_payload(sys.argv[2])
    os.chroot(sys.argv[1])
    os.chdir(cwd)
    for capability in DANGEROUS_CAPABILITIES:
        prctl(PR_CAPBSET_DROP, capability)
    prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL)
    prctl(PR_SET_NO_NEW_PRIVS, 1)
    workload = f"{command}\nstatus=$?\nwait\nexit $status"
    os.execve("/bin/bash", ["/bin/bash", "-lc", workload], environment)


if __name__ == "__main__":
    main()
