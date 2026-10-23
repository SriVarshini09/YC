import os
import requests
import httpx
import aiohttp
from urllib.parse import quote

QBO = "https://quickbooks.api.intuit.com"
GRAPH = os.getenv("GRAPH_URL", "https://graph.facebook.com/v21.0")


def dispatch(owner, repo, workflow, token):
    r = requests.post(
        f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/{quote(workflow)}/dispatches",
        json={"ref": "main"},
        headers={"Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28"},
    )
    if r.status_code != 204:
        raise RuntimeError(f"dispatch failed with {r.status_code}")


def open_invoices(realm_id, token):
    res = requests.get(QBO + f"/v3/company/{realm_id}/query", params={"query": "select * from Invoice", "minorversion": 65})
    res.raise_for_status()
    data = res.json()
    return [inv["Id"] for inv in data["QueryResponse"]["Invoice"]]


class Hub:
    def __init__(self, token):
        self.http = httpx.Client(base_url="https://api.hubapi.com", headers={"Authorization": f"Bearer {token}"})

    def stage_ids(self):
        resp = self.http.get("/crm-pipelines/v1/pipelines/deals")
        body = resp.json()
        ids = []
        for p in body["results"]:
            ids.append(p["pipelineId"])
            if p.get("label") == "Sales":
                ids.extend(s["stageId"] for s in p["stages"])
        return ids


async def page_name(page_id, token):
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{GRAPH}/{page_id}", params={"fields": "name"}) as resp:
            if resp.status in (200, 201):
                data = await resp.json()
                return data.get("name")
