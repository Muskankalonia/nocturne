"use client";

import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import type { AssistantMessage, AssistantResponse } from "@/server/nlq-assistant";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: AssistantResponse["citations"];
  suggestedFollowUps?: string[];
  loading?: boolean;
}

interface UseAssistantReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
}

export function useAssistant(): UseAssistantReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    setError(null);
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: content.trim(),
    };

    const loadingMessage: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      loading: true,
    };

    setMessages((prev) => [...prev, userMessage, loadingMessage]);
    setIsLoading(true);

    // Build history from existing messages (exclude the loading placeholder)
    const history: AssistantMessage[] = messages
      .filter((m) => !m.loading)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      abortRef.current = new AbortController();
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content.trim(), history }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Request failed with status ${response.status}`,
        );
      }

      const result: AssistantResponse = await response.json();

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === loadingMessage.id
            ? {
                ...msg,
                content: result.answer,
                citations: result.citations,
                suggestedFollowUps: result.suggestedFollowUps,
                loading: false,
              }
            : msg,
        ),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const errorMessage =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(errorMessage);
      setMessages((prev) => prev.filter((msg) => msg.id !== loadingMessage.id));
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [isLoading, messages]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return { messages, isLoading, error, sendMessage, clearMessages };
}
