from fastapi.testclient import TestClient

from formsocket_python import create_app


def test_realtime_updates_do_not_echo_and_patches_broadcast() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/form/project-brief") as editor_one, client.websocket_connect("/form/project-brief") as editor_two:
            assert editor_one.receive_json()["type"] == "ready"
            assert editor_one.receive_json()["type"] == "presence-state"
            assert editor_two.receive_json()["type"] == "ready"
            assert editor_two.receive_json()["type"] == "presence-state"

            editor_one.send_json({"type": "update", "field": "title", "value": "Launch plan"})
            assert editor_two.receive_json() == {
                "type": "update",
                "documentId": "project-brief",
                "field": "title",
                "value": "Launch plan",
            }

            response = client.patch("/api/documents/project-brief", json={"changes": {"title": "Launch plan"}})
            assert response.status_code == 200
            assert editor_one.receive_json() == response.json()
            assert editor_two.receive_json() == response.json()


def test_invalid_patch_is_rejected() -> None:
    with TestClient(create_app()) as client:
        response = client.patch("/api/documents/project-brief", json={"changes": {}})

    assert response.status_code == 400