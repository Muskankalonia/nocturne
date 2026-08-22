/**
 * Cross-tab polling deduplication via BroadcastChannel.
 *
 * When multiple tabs are open, only the "leader" tab fetches data; others
 * receive the result via the channel. If the leader tab closes, another tab
 * claims leadership after a short delay.
 */

const LEADER_HEARTBEAT_MS = 10_000;
const LEADER_TIMEOUT_MS = 15_000;

type Message<T> =
  | { type: "leader-heartbeat"; tabId: string }
  | { type: "data"; payload: T }
  | { type: "request-fetch" };

interface BroadcastPollOptions<T> {
  channelName: string;
  fetchData: () => Promise<T>;
  onData: (data: T) => void;
  intervalMs: number;
}

export function createBroadcastPoll<T>({
  channelName,
  fetchData,
  onData,
  intervalMs,
}: BroadcastPollOptions<T>) {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    // Fallback: no BroadcastChannel support, just poll normally.
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const data = await fetchData();
        onData(data);
      } catch {
        // Swallow — the page's own error handling covers this.
      }
    }

    return {
      start() {
        void poll();
        timer = setInterval(poll, intervalMs);
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
      },
      requestFetch() {
        void poll();
      },
    };
  }

  const tabId = crypto.randomUUID();
  const channel = new BroadcastChannel(channelName);
  let isLeader = false;
  let lastLeaderHeartbeat = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let leaderCheckTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcastHeartbeat() {
    const msg: Message<T> = { type: "leader-heartbeat", tabId };
    channel.postMessage(msg);
  }

  function broadcastData(data: T) {
    const msg: Message<T> = { type: "data", payload: data };
    channel.postMessage(msg);
  }

  async function leaderPoll() {
    try {
      const data = await fetchData();
      onData(data);
      broadcastData(data);
    } catch {
      // Let individual tab error handling deal with it.
    }
  }

  function becomeLeader() {
    if (isLeader) return;
    isLeader = true;
    broadcastHeartbeat();
    heartbeatTimer = setInterval(broadcastHeartbeat, LEADER_HEARTBEAT_MS);
    void leaderPoll();
    pollTimer = setInterval(leaderPoll, intervalMs);
  }

  function stepDown() {
    isLeader = false;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
  }

  function scheduleLeaderCheck() {
    if (leaderCheckTimer) clearTimeout(leaderCheckTimer);
    leaderCheckTimer = setTimeout(() => {
      const elapsed = Date.now() - lastLeaderHeartbeat;
      if (elapsed > LEADER_TIMEOUT_MS && !isLeader) {
        becomeLeader();
      }
    }, LEADER_TIMEOUT_MS + Math.random() * 2000);
  }

  function handleMessage(event: MessageEvent<Message<T>>) {
    const msg = event.data;
    if (msg.type === "leader-heartbeat") {
      if (msg.tabId !== tabId) {
        lastLeaderHeartbeat = Date.now();
        if (isLeader) stepDown();
        scheduleLeaderCheck();
      }
    } else if (msg.type === "data") {
      if (!isLeader) {
        onData(msg.payload);
      }
    } else if (msg.type === "request-fetch") {
      if (isLeader) void leaderPoll();
    }
  }

  return {
    start() {
      channel.addEventListener("message", handleMessage);
      // Try to become leader immediately; if another tab is already leading,
      // its next heartbeat will cause us to step down.
      becomeLeader();
    },
    stop() {
      stepDown();
      if (leaderCheckTimer) clearTimeout(leaderCheckTimer);
      channel.removeEventListener("message", handleMessage);
      channel.close();
    },
    /** Request the leader to fetch fresh data now (e.g., after a triage action). */
    requestFetch() {
      if (isLeader) {
        void leaderPoll();
      } else {
        const msg: Message<T> = { type: "request-fetch" };
        channel.postMessage(msg);
      }
    },
  };
}
