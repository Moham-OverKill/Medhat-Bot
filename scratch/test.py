import urllib.request
import json

url = "https://medhat-bot-production.up.railway.app/dblwebhook"
headers = {
    "Authorization": "whs_93aca7e0c8b1658bf041d7e449df28f8f678b1a1d00bbc160a50a84959e9a831",
    "Content-Type": "application/json"
}
# Using the bot client ID (815148891598356502) as the user ID for testing
data = {
    "type": "vote.create",
    "data": {
        "id": "mock_vote_id_12345",
        "weight": 1,
        "user": {
            "platform_id": "815148891598356502",
            "name": "BotSelfTest"
        }
    }
}

req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers=headers, method='POST')
try:
    with urllib.request.urlopen(req) as response:
        print("STATUS:", response.status)
        print("BODY:", response.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print("STATUS:", e.code)
    print("BODY:", e.read().decode('utf-8'))
