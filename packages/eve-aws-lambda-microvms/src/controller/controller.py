#!/usr/bin/env python3
import hashlib
import json
import os
import posixpath
import shutil
import signal
import stat
import subprocess
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PROTOCOL_VERSION = 1
LOWER_SOURCE = "/opt/eve/lower"
STATE = "/opt/eve/state"
BACKING_IMAGE = f"{STATE}/controlled-root.ext4"
BACKING = f"{STATE}/controlled-root"
LOWER = f"{BACKING}/lower"
UPPER = f"{BACKING}/upper"
WORK = f"{BACKING}/work"
ROOT = f"{BACKING}/root"
LOGS = f"{STATE}/logs"
ARCHIVES = f"{STATE}/archives"
PART_SIZE = 64 * 1024 * 1024
FILE_CHUNK_SIZE = 4 * 1024 * 1024

state_lock = threading.RLock()
processes = {}
writes = {}
dirty = False
frozen = False
microvm_id = None


def run_checked(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def is_mounted(path):
    return subprocess.run(
        ["mountpoint", "-q", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode == 0


def ensure_directories():
    for path in (STATE, BACKING, LOGS, ARCHIVES):
        os.makedirs(path, exist_ok=True)


def ensure_backing_filesystem():
    ensure_directories()
    if not os.path.exists(BACKING_IMAGE):
        run_checked(["truncate", "-s", "30G", BACKING_IMAGE])
        run_checked(["mkfs.ext4", "-q", "-m", "0", BACKING_IMAGE])
    mount_if_needed(["mount", "-o", "loop", BACKING_IMAGE, BACKING], BACKING)
    initialized = f"{BACKING}/.initialized"
    if not os.path.exists(initialized):
        for path in (LOWER, UPPER, WORK, ROOT):
            os.makedirs(path, exist_ok=True)
        source = subprocess.Popen(
            [
                "tar", "--acls", "--xattrs", "--xattrs-include=*", "--numeric-owner",
                "--one-file-system", "-C", LOWER_SOURCE, "-cf", "-", ".",
            ],
            stdout=subprocess.PIPE,
        )
        try:
            run_checked(
                [
                    "tar", "--acls", "--xattrs", "--xattrs-include=*", "--numeric-owner",
                    "-C", LOWER, "-xf", "-",
                ],
                stdin=source.stdout,
            )
        finally:
            if source.stdout is not None:
                source.stdout.close()
        if source.wait() != 0:
            raise RuntimeError("failed to initialize the controlled root filesystem")
        open(initialized, "wb").close()


def mount_if_needed(args, target):
    if not is_mounted(target):
        run_checked(args)


def ensure_mounted():
    ensure_backing_filesystem()
    for path in (LOWER, UPPER, WORK, ROOT):
        os.makedirs(path, exist_ok=True)
    mount_if_needed(
        ["mount", "-t", "overlay", "overlay", "-o", f"lowerdir={LOWER},upperdir={UPPER},workdir={WORK}", ROOT],
        ROOT,
    )
    run_checked(["mount", "--make-rprivate", ROOT])
    for name in ("proc", "dev", "sys", "run"):
        os.makedirs(f"{ROOT}/{name}", exist_ok=True)
    mount_if_needed(["mount", "-t", "proc", "proc", f"{ROOT}/proc"], f"{ROOT}/proc")
    ensure_device_mounts()
    mount_if_needed(["mount", "--rbind", "/sys", f"{ROOT}/sys"], f"{ROOT}/sys")
    run_checked(["mount", "--make-rslave", f"{ROOT}/sys"])
    mount_if_needed(["mount", "-t", "tmpfs", "tmpfs", f"{ROOT}/run"], f"{ROOT}/run")


def ensure_device_mounts():
    device_root = f"{ROOT}/dev"
    mount_if_needed(
        ["mount", "-t", "tmpfs", "-o", "mode=755,nosuid", "tmpfs", device_root],
        device_root,
    )
    for name in ("full", "null", "random", "tty", "urandom", "zero"):
        target = f"{device_root}/{name}"
        if not os.path.exists(target):
            open(target, "wb").close()
        mount_if_needed(["mount", "--bind", f"/dev/{name}", target], target)
    shared_memory = f"{device_root}/shm"
    os.makedirs(shared_memory, exist_ok=True)
    mount_if_needed(
        ["mount", "-t", "tmpfs", "-o", "mode=1777,nosuid,nodev", "tmpfs", shared_memory],
        shared_memory,
    )
    for name, target in (
        ("fd", "/proc/self/fd"),
        ("stdin", "/proc/self/fd/0"),
        ("stdout", "/proc/self/fd/1"),
        ("stderr", "/proc/self/fd/2"),
    ):
        path = f"{device_root}/{name}"
        if not os.path.lexists(path):
            os.symlink(target, path)


def unmount_root():
    if is_mounted(ROOT):
        subprocess.run(["umount", "-R", ROOT], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def sandbox_path(value):
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("Sandbox paths must be absolute.")
    normalized = posixpath.normpath(value)
    if normalized in ("/proc", "/sys", "/dev", "/run") or normalized.startswith(("/proc/", "/sys/", "/dev/", "/run/")):
        raise ValueError("Pseudo-filesystem paths are not available through file APIs.")
    return normalized


def chroot_command(command, cwd="/workspace", env=None):
    cwd = sandbox_path(cwd)
    process_env = {"HOME": "/root", "LANG": "C.UTF-8", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
    workload_environment = dict(process_env)
    if env:
        workload_environment.update({str(key): str(value) for key, value in env.items()})
    launcher_payload = json.dumps(
        {"command": command, "cwd": cwd, "environment": workload_environment},
        separators=(",", ":"),
    )
    return [
        "unshare", "--mount", "--pid", "--fork", "--kill-child", f"--mount-proc={ROOT}/proc",
        "/usr/bin/python3", "/opt/eve/controller/launcher.py", ROOT, launcher_payload,
    ], process_env


def shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def start_process(payload):
    global dirty
    command = payload.get("command")
    if not isinstance(command, str) or not command:
        raise ValueError("command must be a non-empty string")
    ensure_mounted()
    process_id = payload.get("requestId") or str(uuid.uuid4())
    with state_lock:
        if process_id in processes:
            return process_id
        stdout_path = f"{LOGS}/{process_id}.stdout"
        stderr_path = f"{LOGS}/{process_id}.stderr"
        stdout_file = open(stdout_path, "ab", buffering=0)
        stderr_file = open(stderr_path, "ab", buffering=0)
        args, env = chroot_command(command, payload.get("workingDirectory") or "/workspace", payload.get("env"))
        process = subprocess.Popen(
            args,
            env=env,
            stdout=stdout_file,
            stderr=stderr_file,
            start_new_session=True,
        )
        processes[process_id] = {
            "process": process,
            "stdout": stdout_path,
            "stderr": stderr_path,
            "stdoutFile": stdout_file,
            "stderrFile": stderr_file,
        }
        dirty = True
    return process_id


def process_status(process_id):
    entry = processes.get(process_id)
    if entry is None:
        raise KeyError(process_id)
    exit_code = entry["process"].poll()
    running = process_group_running(entry)
    if not running and not entry["stdoutFile"].closed:
        entry["stdoutFile"].close()
        entry["stderrFile"].close()
    return {"state": "running" if running else "exited", "exitCode": None if running else exit_code}


def process_group_running(entry):
    if entry["process"].poll() is None:
        return True
    try:
        os.killpg(entry["process"].pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_log(process_id, stream, offset):
    if stream not in ("stdout", "stderr"):
        raise ValueError("stream must be stdout or stderr")
    entry = processes.get(process_id)
    if entry is None:
        raise KeyError(process_id)
    path = entry[stream]
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            data = handle.read(1024 * 1024)
            next_offset = handle.tell()
    except FileNotFoundError:
        data = b""
        next_offset = offset
    complete = not process_group_running(entry) and next_offset >= os.path.getsize(path)
    return data, next_offset, complete


def kill_process(process_id):
    entry = processes.get(process_id)
    if entry is None:
        return
    if process_group_running(entry):
        try:
            os.killpg(entry["process"].pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def freeze_workload():
    global frozen
    with state_lock:
        if frozen:
            return
        for entry in processes.values():
            if process_group_running(entry):
                try:
                    os.killpg(entry["process"].pid, signal.SIGSTOP)
                except ProcessLookupError:
                    pass
        run_checked(["sync"])
        frozen = True


def release_workload():
    global frozen
    with state_lock:
        if not frozen:
            return
        for entry in processes.values():
            if process_group_running(entry):
                try:
                    os.killpg(entry["process"].pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
        frozen = False


def prepare_checkpoint():
    if not dirty:
        return {"dirty": False}
    freeze_workload()
    checkpoint_id = str(uuid.uuid4())
    archive_path = f"{ARCHIVES}/{checkpoint_id}.tar.zst"
    run_checked([
        "tar", "--xattrs", "--xattrs-include=*", "--acls", "--numeric-owner", "--sparse", "--one-file-system",
        "--zstd", "-cf", archive_path, "-C", UPPER, "."
    ])
    size = os.path.getsize(archive_path)
    digest = file_sha256(archive_path)
    return {
        "dirty": True,
        "checkpointId": checkpoint_id,
        "size": size,
        "sha256": digest,
        "partSize": PART_SIZE,
        "partCount": max(1, (size + PART_SIZE - 1) // PART_SIZE),
    }


def upload_checkpoint(payload):
    checkpoint_id = payload.get("checkpointId")
    urls = payload.get("urls")
    if not isinstance(checkpoint_id, str) or not isinstance(urls, list):
        raise ValueError("checkpointId and urls are required")
    archive_path = f"{ARCHIVES}/{checkpoint_id}.tar.zst"
    parts = []
    with open(archive_path, "rb") as handle:
        for index, url in enumerate(urls, start=1):
            data = handle.read(PART_SIZE)
            request = urllib.request.Request(url, data=data, method="PUT")
            with urllib.request.urlopen(request, timeout=300) as response:
                etag = response.headers.get("ETag")
            if not etag:
                raise RuntimeError(f"S3 upload part {index} returned no ETag")
            parts.append({"partNumber": index, "etag": etag})
    return {"parts": parts}


def commit_checkpoint(payload):
    global dirty
    checkpoint_id = payload.get("checkpointId")
    if isinstance(checkpoint_id, str):
        try:
            os.remove(f"{ARCHIVES}/{checkpoint_id}.tar.zst")
        except FileNotFoundError:
            pass
    dirty = False


def restore_checkpoint(payload):
    global dirty
    url = payload.get("url")
    expected = payload.get("sha256")
    expected_size = payload.get("size")
    if not isinstance(url, str) or not isinstance(expected, str) or not isinstance(expected_size, int):
        raise ValueError("url, sha256, and size are required")
    archive_path = f"{ARCHIVES}/restore-{uuid.uuid4()}.tar.zst"
    with urllib.request.urlopen(url, timeout=300) as response, open(archive_path, "wb") as output:
        shutil.copyfileobj(response, output)
    if os.path.getsize(archive_path) != expected_size or file_sha256(archive_path) != expected:
        os.remove(archive_path)
        raise ValueError("Checkpoint checksum did not match its manifest.")
    with state_lock:
        if any(process_group_running(entry) for entry in processes.values()):
            raise RuntimeError("Cannot restore while workload processes are running.")
        unmount_root()
        shutil.rmtree(UPPER, ignore_errors=True)
        shutil.rmtree(WORK, ignore_errors=True)
        os.makedirs(UPPER, exist_ok=True)
        os.makedirs(WORK, exist_ok=True)
        run_checked(["tar", "--xattrs", "--xattrs-include=*", "--acls", "--numeric-owner", "--same-owner", "--zstd", "-xf", archive_path, "-C", UPPER])
        os.remove(archive_path)
        ensure_mounted()
        dirty = False


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_file(path, offset, limit):
    path = sandbox_path(path)
    script = (
        "import os,sys; p=sys.argv[1]; "
        "\nif not os.path.exists(p): sys.exit(44)"
        "\nwith open(p, 'rb', buffering=0) as f: f.seek(int(sys.argv[2])); sys.stdout.buffer.write(f.read(int(sys.argv[3])))"
    )
    result = subprocess.run(
        ["chroot", ROOT, "/usr/bin/python3", "-c", script, path, str(offset), str(limit)],
        capture_output=True,
    )
    if result.returncode == 44:
        return None
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace"))
    return result.stdout, len(result.stdout) < limit


def begin_write(path):
    path = sandbox_path(path)
    write_id = str(uuid.uuid4())
    os.makedirs(f"{STATE}/writes", exist_ok=True)
    temporary_path = f"{STATE}/writes/{write_id}"
    open(temporary_path, "wb").close()
    writes[write_id] = {"path": path, "temporaryPath": temporary_path, "offset": 0}
    return write_id


def write_chunk(write_id, offset, content):
    entry = writes.get(write_id)
    if entry is None:
        raise KeyError(write_id)
    if offset != entry["offset"]:
        raise ValueError(f"write chunk offset {offset} did not match expected offset {entry['offset']}")
    with open(entry["temporaryPath"], "ab", buffering=0) as output:
        output.write(content)
    entry["offset"] += len(content)


def commit_write(write_id):
    global dirty
    entry = writes.pop(write_id, None)
    if entry is None:
        raise KeyError(write_id)
    path = entry["path"]
    parent = posixpath.dirname(path)
    script = (
        f"mkdir -p -- {shell_quote(parent)} && "
        f"temporary=$(mktemp {shell_quote(parent + '/.eve-write.XXXXXX')}) && "
        f"cat > \"$temporary\" && mv -f -- \"$temporary\" {shell_quote(path)}"
    )
    try:
        with open(entry["temporaryPath"], "rb") as content:
            run_checked(["chroot", ROOT, "/bin/bash", "-lc", script], stdin=content)
        dirty = True
    finally:
        try:
            os.remove(entry["temporaryPath"])
        except FileNotFoundError:
            pass


def abort_write(write_id):
    entry = writes.pop(write_id, None)
    if entry is None:
        return
    try:
        os.remove(entry["temporaryPath"])
    except FileNotFoundError:
        pass


def reset_for_run(payload):
    global dirty, frozen, microvm_id
    microvm_id = payload.get("microvmId")
    if not isinstance(microvm_id, str) or not microvm_id:
        raise ValueError("run hook payload omitted microvmId")
    run_hook_payload = payload.get("runHookPayload")
    if isinstance(run_hook_payload, str) and run_hook_payload:
        decoded = json.loads(run_hook_payload)
        if decoded.get("controllerProtocolVersion") != PROTOCOL_VERSION:
            raise ValueError("run hook requested an incompatible controller protocol")
    for write_id in list(writes):
        abort_write(write_id)
    shutil.rmtree(LOGS, ignore_errors=True)
    shutil.rmtree(ARCHIVES, ignore_errors=True)
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(ARCHIVES, exist_ok=True)
    processes.clear()
    dirty = False
    frozen = False


def validate_controller():
    ensure_mounted()
    run_checked(["unshare", "--mount", "/bin/true"])
    run_checked(["chroot", ROOT, "/bin/true"])
    validation_directory = f"{UPPER}/.eve-capability-validation"
    shutil.rmtree(validation_directory, ignore_errors=True)
    os.makedirs(validation_directory)
    probe = f"{validation_directory}/probe"
    whiteout = f"{validation_directory}/whiteout"
    try:
        with open(probe, "wb") as output:
            output.write(b"eve")
        os.setxattr(probe, b"user.eve", b"validation")
        run_checked(["setfacl", "-m", "u:1234:r", probe])
        os.mknod(whiteout, stat.S_IFCHR | 0o600, os.makedev(0, 0))
        if not stat.S_ISCHR(os.lstat(whiteout).st_mode):
            raise RuntimeError("overlay whiteout capability validation failed")
    finally:
        shutil.rmtree(validation_directory, ignore_errors=True)


def remove_path(path, recursive, force):
    global dirty
    path = sandbox_path(path)
    flags = ("r" if recursive else "") + ("f" if force else "")
    args = ["chroot", ROOT, "rm"] + ([f"-{flags}"] if flags else []) + ["--", path]
    run_checked(args)
    dirty = True


class JsonHandler(BaseHTTPRequestHandler):
    server_version = "eve-lambda-microvm/1"

    def log_message(self, format_string, *args):
        print(json.dumps({"component": "controller", "message": format_string % args}), flush=True)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def read_json(self):
        body = self.read_body()
        return json.loads(body) if body else {}

    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, status, value, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(value)))
        for key, item in (headers or {}).items():
            self.send_header(key, str(item))
        self.end_headers()
        self.wfile.write(value)

    def handle_error(self, error):
        status = 404 if isinstance(error, KeyError) else 400 if isinstance(error, ValueError) else 500
        self.send_json(status, {"error": type(error).__name__, "message": str(error)})


class ControlHandler(JsonHandler):
    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path in ("/", "/v1/health", "/v1/heartbeat"):
                ensure_mounted()
                self.send_json(200, {"protocolVersion": PROTOCOL_VERSION, "status": "ready", "microvmId": microvm_id})
                return
            if parsed.path == "/v1/files":
                query = parse_qs(parsed.query)
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", [str(FILE_CHUNK_SIZE)])[0])
                if offset < 0 or limit < 1 or limit > FILE_CHUNK_SIZE:
                    raise ValueError("file offset or limit is invalid")
                result = read_file(query.get("path", [""])[0], offset, limit)
                if result is None:
                    self.send_json(404, {"error": "NotFound"})
                else:
                    content, complete = result
                    self.send_bytes(200, content, {
                        "X-Eve-Next-Offset": offset + len(content),
                        "X-Eve-Complete": str(complete).lower(),
                    })
                return
            segments = parsed.path.strip("/").split("/")
            if len(segments) == 3 and segments[:2] == ["v1", "processes"]:
                self.send_json(200, process_status(segments[2]))
                return
            if len(segments) == 5 and segments[:2] == ["v1", "processes"] and segments[3] == "logs":
                offset = int(parse_qs(parsed.query).get("offset", ["0"])[0])
                data, next_offset, complete = process_log(segments[2], segments[4], offset)
                self.send_bytes(200, data, {"X-Eve-Next-Offset": next_offset, "X-Eve-Complete": str(complete).lower()})
                return
            self.send_json(404, {"error": "NotFound"})
        except Exception as error:
            self.handle_error(error)

    def do_POST(self):
        try:
            if self.path == "/v1/processes":
                self.send_json(201, {"processId": start_process(self.read_json())})
            elif self.path == "/v1/files/writes":
                self.send_json(201, {"writeId": begin_write(self.read_json().get("path"))})
            elif self.path.startswith("/v1/files/writes/") and self.path.endswith("/commit"):
                write_id = self.path.split("/")[4]
                commit_write(write_id)
                self.send_json(200, {"status": "written"})
            elif self.path == "/v1/checkpoints/prepare":
                self.send_json(200, prepare_checkpoint())
            elif self.path == "/v1/checkpoints/upload":
                self.send_json(200, upload_checkpoint(self.read_json()))
            elif self.path == "/v1/checkpoints/commit":
                commit_checkpoint(self.read_json())
                self.send_json(200, {"status": "committed"})
            elif self.path == "/v1/checkpoints/release":
                release_workload()
                self.send_json(200, {"status": "released"})
            elif self.path == "/v1/checkpoints/restore":
                restore_checkpoint(self.read_json())
                self.send_json(200, {"status": "restored"})
            else:
                self.send_json(404, {"error": "NotFound"})
        except Exception as error:
            self.handle_error(error)

    def do_PUT(self):
        try:
            parsed = urlparse(self.path)
            segments = parsed.path.strip("/").split("/")
            if len(segments) != 4 or segments[:3] != ["v1", "files", "writes"]:
                self.send_json(404, {"error": "NotFound"})
                return
            offset = int(parse_qs(parsed.query).get("offset", ["-1"])[0])
            write_chunk(segments[3], offset, self.read_body())
            self.send_json(200, {"status": "accepted"})
        except Exception as error:
            self.handle_error(error)

    def do_DELETE(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/v1/files":
                query = parse_qs(parsed.query)
                remove_path(query.get("path", [""])[0], query.get("recursive", ["false"])[0] == "true", query.get("force", ["false"])[0] == "true")
                self.send_json(200, {"status": "removed"})
                return
            segments = parsed.path.strip("/").split("/")
            if len(segments) == 4 and segments[:3] == ["v1", "files", "writes"]:
                abort_write(segments[3])
                self.send_json(200, {"status": "aborted"})
                return
            if len(segments) == 3 and segments[:2] == ["v1", "processes"]:
                kill_process(segments[2])
                self.send_json(200, {"status": "killed"})
                return
            self.send_json(404, {"error": "NotFound"})
        except Exception as error:
            self.handle_error(error)


class HookHandler(JsonHandler):
    def do_POST(self):
        global microvm_id
        try:
            payload = self.read_json()
            if self.path.endswith(("/ready", "/validate")):
                validate_controller()
            elif self.path.endswith("/run"):
                ensure_mounted()
                reset_for_run(payload)
            elif self.path.endswith("/suspend"):
                run_checked(["sync"])
            elif self.path.endswith("/resume"):
                ensure_mounted()
                release_workload()
            elif not self.path.endswith("/terminate"):
                self.send_json(404, {"error": "NotFound"})
                return
            self.send_json(200, {"status": "ok"})
        except Exception as error:
            self.handle_error(error)


def serve(server):
    server.serve_forever()


def main():
    ensure_mounted()
    control = ThreadingHTTPServer(("0.0.0.0", 8080), ControlHandler)
    hooks = ThreadingHTTPServer(("0.0.0.0", 9000), HookHandler)
    threading.Thread(target=serve, args=(hooks,), daemon=True).start()
    control.serve_forever()


if __name__ == "__main__":
    main()
