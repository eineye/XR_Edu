from __future__ import annotations

import json
import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from ..audit import audit
from ..db import get_db, rows_to_dicts
from ..security import any_user, operator_user
from ..timeutil import now_iso

router = APIRouter(prefix="/api/v1/contents", tags=["contents"])

Category = Literal["career", "safety", "environment"]
CATEGORY_LABELS = {"career": "진로", "safety": "안전", "environment": "환경"}

# 원격 설치는 Meta Quest 공식 배포 도구·운영 정책 검증 전까지 지원하지 않는다. 체크리스트로 관리.
DEFAULT_CHECKLIST = [
    "패키지(APK) 버전 및 서명 확인",
    "대상 HMD 충전 및 Wi-Fi 연결 확인",
    "Meta Quest 개발자 모드/MDM 등 공식 배포 경로로 설치",
    "HMD에서 콘텐츠 실행 확인",
    "HMD heartbeat 로 보고된 설치 버전 확인",
]


class ContentCreate(BaseModel):
    content_id: str = Field(max_length=64)
    title: str = Field(min_length=1, max_length=200)
    category: Category
    description: str | None = Field(default=None, max_length=2000)
    version: str = Field(min_length=1, max_length=32)
    package_name: str | None = Field(default=None, max_length=200)
    package_size: int | None = Field(default=None, ge=0)
    supported_models: str = Field(default="Meta Quest 3", max_length=200)

    @field_validator("content_id")
    @classmethod
    def _cid(cls, v: str) -> str:
        v = v.strip()
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", v):
            raise ValueError("콘텐츠 ID는 영문·숫자·-·_·. 2~64자여야 합니다 (예: SAFETY-01)")
        return v


class ContentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    category: Category | None = None
    description: str | None = Field(default=None, max_length=2000)
    supported_models: str | None = Field(default=None, max_length=200)
    active: bool | None = None


class VersionCreate(BaseModel):
    version: str = Field(min_length=1, max_length=32)
    package_name: str | None = Field(default=None, max_length=200)
    package_size: int | None = Field(default=None, ge=0)
    release_notes: str | None = Field(default=None, max_length=2000)
    make_current: bool = True


class DeployCreate(BaseModel):
    version: str = Field(min_length=1, max_length=32)
    target_devices: list[str] = Field(min_length=1)
    memo: str | None = Field(default=None, max_length=1000)


class DeployUpdate(BaseModel):
    status: Literal["planned", "in_progress", "done", "cancelled"] | None = None
    checklist: list[dict] | None = None
    memo: str | None = Field(default=None, max_length=1000)


def _get(conn, content_id: str):
    row = conn.execute("SELECT * FROM contents WHERE content_id=?", (content_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "콘텐츠를 찾을 수 없습니다")
    return row


@router.get("")
def list_contents(active_only: bool = False, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    sql = "SELECT * FROM contents" + (" WHERE active=1" if active_only else "") + " ORDER BY content_id"
    items = rows_to_dicts(conn.execute(sql).fetchall())
    total_devices = conn.execute("SELECT COUNT(*) FROM devices WHERE active=1").fetchone()[0]
    for c in items:
        c["category_label"] = CATEGORY_LABELS[c["category"]]
        c["installed_count"] = conn.execute(
            "SELECT COUNT(*) FROM content_installs WHERE content_id=? AND status='installed'", (c["content_id"],)).fetchone()[0]
        c["installed_current_count"] = conn.execute(
            "SELECT COUNT(*) FROM content_installs WHERE content_id=? AND status='installed' AND version=?",
            (c["content_id"], c["version"])).fetchone()[0]
        c["total_devices"] = total_devices
        c["result_count"] = conn.execute("SELECT COUNT(*) FROM mission_results WHERE content_id=?", (c["content_id"],)).fetchone()[0]
    return {"items": items, "categories": CATEGORY_LABELS}


@router.post("", status_code=201)
def create_content(body: ContentCreate, user: dict = Depends(operator_user), conn: sqlite3.Connection = Depends(get_db)):
    if conn.execute("SELECT 1 FROM contents WHERE content_id=?", (body.content_id,)).fetchone():
        raise HTTPException(409, f"이미 등록된 콘텐츠 ID입니다: {body.content_id}")
    now = now_iso()
    conn.execute(
        """INSERT INTO contents(content_id, title, category, description, version, package_name, package_size,
             supported_models, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (body.content_id, body.title, body.category, body.description, body.version, body.package_name,
         body.package_size, body.supported_models, now, now))
    conn.execute("INSERT INTO content_versions(content_id, version, package_name, package_size, release_notes, created_at)"
                 " VALUES (?,?,?,?,?,?)", (body.content_id, body.version, body.package_name, body.package_size, "최초 등록", now))
    audit(conn, user, "content.create", "content", body.content_id, body.model_dump())
    conn.commit()
    return dict(_get(conn, body.content_id))


@router.get("/{content_id}")
def content_detail(content_id: str, user: dict = Depends(any_user), conn: sqlite3.Connection = Depends(get_db)):
    d = dict(_get(conn, content_id))
    d["category_label"] = CATEGORY_LABELS[d["category"]]
    d["versions"] = rows_to_dicts(conn.execute(
        "SELECT * FROM content_versions WHERE content_id=? ORDER BY id DESC", (content_id,)).fetchall())
    d["installs"] = rows_to_dicts(conn.execute(
        """SELECT d.device_id, d.device_name, d.active, i.version, i.status, i.source, i.updated_at
           FROM devices d LEFT JOIN content_installs i ON i.device_id=d.device_id AND i.content_id=?
           ORDER BY d.device_id""", (content_id,)).fetchall())
    d["deploy_jobs"] = [
        {**j, "target_devices": json.loads(j["target_devices_json"]), "checklist": json.loads(j["checklist_json"])}
        for j in rows_to_dicts(conn.execute(
            "SELECT * FROM deploy_jobs WHERE content_id=? ORDER BY id DESC", (content_id,)).fetchall())]
    d["remote_install_supported"] = False
    d["remote_install_note"] = "기기 연동 검증 필요: Meta Quest 공식 배포·개발자 도구 검증 전까지 원격 설치는 지원하지 않습니다."
    return d


@router.patch("/{content_id}")
def update_content(content_id: str, body: ContentUpdate, user: dict = Depends(operator_user),
                   conn: sqlite3.Connection = Depends(get_db)):
    _get(conn, content_id)
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(400, "변경할 항목이 없습니다")
    if "active" in data:
        data["active"] = 1 if data["active"] else 0
    conn.execute(f"UPDATE contents SET {', '.join(f'{k}=?' for k in data)}, updated_at=? WHERE content_id=?",
                 (*data.values(), now_iso(), content_id))
    audit(conn, user, "content.update", "content", content_id, body.model_dump(exclude_unset=True))
    conn.commit()
    return content_detail(content_id, user, conn)


@router.post("/{content_id}/versions", status_code=201)
def add_version(content_id: str, body: VersionCreate, user: dict = Depends(operator_user),
                conn: sqlite3.Connection = Depends(get_db)):
    _get(conn, content_id)
    if conn.execute("SELECT 1 FROM content_versions WHERE content_id=? AND version=?", (content_id, body.version)).fetchone():
        raise HTTPException(409, f"이미 등록된 버전입니다: {body.version}")
    now = now_iso()
    conn.execute("INSERT INTO content_versions(content_id, version, package_name, package_size, release_notes, created_at)"
                 " VALUES (?,?,?,?,?,?)", (content_id, body.version, body.package_name, body.package_size,
                                          body.release_notes, now))
    if body.make_current:
        conn.execute("UPDATE contents SET version=?, package_name=COALESCE(?, package_name),"
                     " package_size=COALESCE(?, package_size), updated_at=? WHERE content_id=?",
                     (body.version, body.package_name, body.package_size, now, content_id))
    audit(conn, user, "content.version_add", "content", content_id, body.model_dump())
    conn.commit()
    return content_detail(content_id, user, conn)


@router.post("/{content_id}/deploy-jobs", status_code=201)
def create_deploy_job(content_id: str, body: DeployCreate, user: dict = Depends(operator_user),
                      conn: sqlite3.Connection = Depends(get_db)):
    _get(conn, content_id)
    if not conn.execute("SELECT 1 FROM content_versions WHERE content_id=? AND version=?", (content_id, body.version)).fetchone():
        raise HTTPException(400, f"등록되지 않은 버전입니다: {body.version}")
    known = {r[0] for r in conn.execute("SELECT device_id FROM devices").fetchall()}
    unknown = [d for d in body.target_devices if d not in known]
    if unknown:
        raise HTTPException(400, f"등록되지 않은 장비: {', '.join(unknown)}")
    now = now_iso()
    checklist = [{"item": c, "done": False} for c in DEFAULT_CHECKLIST]
    cur = conn.execute(
        "INSERT INTO deploy_jobs(content_id, version, target_devices_json, checklist_json, memo, created_by, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (content_id, body.version, json.dumps(body.target_devices), json.dumps(checklist, ensure_ascii=False),
         body.memo, user["id"], now, now))
    for d in body.target_devices:
        conn.execute(
            """INSERT INTO content_installs(device_id, content_id, version, source, status, updated_at)
               VALUES (?,?,?,'manual','planned',?) ON CONFLICT(device_id, content_id) DO UPDATE SET
               status=CASE WHEN content_installs.version=excluded.version AND content_installs.status='installed'
                           THEN 'installed' ELSE 'planned' END,
               updated_at=excluded.updated_at""", (d, content_id, body.version, now))
    audit(conn, user, "content.deploy_job_create", "content", content_id, body.model_dump())
    conn.commit()
    return {"id": cur.lastrowid}


@router.patch("/deploy-jobs/{job_id}")
def update_deploy_job(job_id: int, body: DeployUpdate, user: dict = Depends(operator_user),
                      conn: sqlite3.Connection = Depends(get_db)):
    if conn.execute("SELECT 1 FROM deploy_jobs WHERE id=?", (job_id,)).fetchone() is None:
        raise HTTPException(404, "배포 작업을 찾을 수 없습니다")
    data = {}
    if body.status:
        data["status"] = body.status
    if body.checklist is not None:
        data["checklist_json"] = json.dumps(body.checklist, ensure_ascii=False)
    if body.memo is not None:
        data["memo"] = body.memo
    if not data:
        raise HTTPException(400, "변경할 항목이 없습니다")
    conn.execute(f"UPDATE deploy_jobs SET {', '.join(f'{k}=?' for k in data)}, updated_at=? WHERE id=?",
                 (*data.values(), now_iso(), job_id))
    audit(conn, user, "content.deploy_job_update", "deploy_job", job_id, body.model_dump(exclude_none=True))
    conn.commit()
    return {"success": True}
