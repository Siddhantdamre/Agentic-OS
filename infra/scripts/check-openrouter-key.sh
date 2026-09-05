#!/usr/bin/env bash
# Is this key usable? Answers in one second, with the reason if not.
#
#   bash infra/scripts/check-openrouter-key.sh sk-or-v1-....
#
# A key needs BOTH of these, and they are separate settings:
#   the ACCOUNT has purchased credits   ->  "free_tier: false"
#   the KEY has no spending cap         ->  "limit: null"
K="${1:?paste the key as the first argument}"
echo "--- key metadata ---"
curl -s -m 20 https://openrouter.ai/api/v1/key -H "Authorization: Bearer $K" \
  | python -c "import sys,json;d=json.load(sys.stdin).get('data',{});print('  paid account :',not d.get('is_free_tier'));print('  key cap      :',d.get('limit') if d.get('limit') is not None else 'none (good)');print('  remaining    :',d.get('limit_remaining'));print('  spent        : \$%.4f'%d.get('usage',0))"
echo "--- real call ---"
R=$(curl -s -m 45 -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Say OK"}],"max_tokens":20}')
if echo "$R" | grep -q '"choices"'; then
  echo "  USABLE — this key works. Send it over."
else
  echo "  NOT USABLE:"
  echo "$R" | python -c "import sys,json;print('   ',json.load(sys.stdin).get('error',{}).get('message','unknown')[:200])" 2>/dev/null || echo "    $R"
fi
