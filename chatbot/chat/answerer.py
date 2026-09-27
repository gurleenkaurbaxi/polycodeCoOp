"""
Single Groq LLM call per user message.

Uses llama-3.1-8b-instant via Groq's API.
Smaller model = higher free tier limits and faster responses.
"""

from groq import Groq

from conversation.store import Conversation
from chat.context import build_system_prompt


def get_answer(client: Groq, conversation: Conversation, user_message: str) -> str:
    system_prompt = build_system_prompt(conversation.context_json)

    messages = (
        [{"role": "system", "content": system_prompt}]
        + conversation.messages
        + [{"role": "user", "content": user_message}]
    )

    try:
        response = client.chat.completions.create(
            model="qwen/qwen3.8-27b",
            max_tokens=1024,
            messages=messages,
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"[Groq error] {type(e).__name__}: {e}")
        raise