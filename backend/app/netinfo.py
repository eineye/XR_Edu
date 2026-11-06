"""관리자 PC 네트워크 정보 (조회만 함. 네트워크 인터페이스·방화벽은 변경하지 않는다)."""
from __future__ import annotations

import socket


def local_ips() -> list[str]:
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 실제 패킷은 보내지 않음 (기본 경로 인터페이스 확인용)
        s.connect(("192.168.50.1", 9))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    ips.discard("127.0.0.1")
    return sorted(ips) or ["127.0.0.1"]
