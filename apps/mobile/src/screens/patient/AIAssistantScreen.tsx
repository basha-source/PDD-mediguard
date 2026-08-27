import { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { collection, addDoc, query, where, getDocs } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { Colors } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";
import { ENV } from "@/config/env";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_QUESTIONS = [
  "What are the side effects of Paracetamol?",
  "Can I take medicines on an empty stomach?",
  "What is the maximum daily dose of Ibuprofen?",
  "Can I take Aspirin and Ibuprofen together?",
  "How should I store my medicines?",
  "Is it safe to take medicines during pregnancy?",
];

const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "Hi! I'm MediGuard AI. I can help answer questions about your medicines, dosages, interactions, and side effects. Remember to always consult your doctor for medical advice.",
  createdAt: "",
};

// The backend's worst case for /ask is 25s + 3s retry delay + 25s = 53s (see
// apps/backend/src/services/mlService.ts). This budget must stay strictly
// larger: aborting first would replace the real reason for a failure with a
// misleading "took too long" and hide it from us entirely.
const REQUEST_TIMEOUT_MS = 60_000;

// The backend reduces every /ask failure to a `code` (see backend routes/ai.ts).
// One generic sentence for all of them made this screen impossible to debug —
// a stopped AI service and an unbuilt search index both read as "try again".
// Each code gets its own line: specific enough to tell us what actually broke,
// but written for a patient, so nothing here sounds alarming or technical.
const ERROR_MESSAGES: Record<string, string> = {
  warming_up:    "The assistant is still starting up. Please try again in a few seconds.",
  index_missing: "My medical reference isn't ready yet, so I can't answer questions just now. Please try again a little later.",
  unreachable:   "I can't reach the assistant right now. Please check your connection and try again.",
  timeout:       "That's taking longer than usual to answer. Please try again.",
  unknown:       "Something went wrong while working out an answer. Please try again.",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AIAssistantScreen() {
  const navigation = useNavigation();
  const user = useAuthStore((s) => s.user);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const flatListRef = useRef<FlatList>(null);
  const sendingRef = useRef(false); // ref-based guard prevents stale-closure duplicate sends

  // ── Load chat history from Firestore on mount ──────────────────────────────
  useEffect(() => {
    if (!user) {
      setInitialLoading(false);
      return;
    }
    getDocs(
      query(
        collection(getDb(), "chatHistory"),
        where("userId", "==", user.id),
      ),
    )
      .then((snap) => {
        const history: ChatMessage[] = snap.docs
          .map((doc) => {
            const d = doc.data();
            return {
              id: doc.id,
              role: d.role as "user" | "assistant",
              text: d.text,
              createdAt: d.createdAt,
            };
          })
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        setMessages(history);
      })
      .catch(() => {
        // silently fail — user will start with empty chat
      })
      .finally(() => setInitialLoading(false));
  }, [user]);

  // ── Scroll to bottom helper ────────────────────────────────────────────────
  function scrollToBottom() {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }

  // ── Send message ───────────────────────────────────────────────────────────
  async function sendMessage(text?: string) {
    const q = (text ?? input).trim();
    if (!q || sendingRef.current) return;
    sendingRef.current = true;
    setInput("");

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text: q,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    scrollToBottom();

    if (user) {
      addDoc(collection(getDb(), "chatHistory"), {
        userId: user.id, role: "user", text: q, createdAt: userMsg.createdAt,
      }).catch(() => {});
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // Resolves to the assistant's answer, or to the reason we could not get one.
    let reply: string;
    let isAnswer = false;

    try {
      const res = await fetch(`${ENV.BACKEND_URL}/api/ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Parse the body even when the status is an error — the reason for the
      // failure lives in that body, and reading it is the whole point.
      const data: Record<string, any> = await res.json().catch(() => ({}));

      if (res.ok && typeof data.answer === "string" && data.answer.trim()) {
        reply = data.answer;
        isAnswer = true;
      } else {
        const code = typeof data.code === "string" ? data.code : "unknown";
        // `detail` is developer material — it goes to the log, never the bubble.
        console.warn(
          `[AI] /ask ${res.status} (${code}):`,
          JSON.stringify(data.detail ?? data.error ?? null),
        );
        reply = ERROR_MESSAGES[code] ?? ERROR_MESSAGES["unknown"]!;
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      // fetch itself threw: either our own abort fired, or the phone never
      // reached the backend at all (wrong LAN IP, server not running, no Wi-Fi).
      reply = err?.name === "AbortError"
        ? ERROR_MESSAGES["timeout"]!
        : ERROR_MESSAGES["unreachable"]!;
    }

    const aiMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      text: reply,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, aiMsg]);
    scrollToBottom();

    // Only real answers are persisted — a transient outage should not come back
    // as part of the conversation the next time the user opens this screen.
    if (user && isAnswer) {
      addDoc(collection(getDb(), "chatHistory"), {
        userId: user.id, role: "assistant", text: reply, createdAt: aiMsg.createdAt,
      }).catch(() => {});
    }

    setLoading(false);
    sendingRef.current = false;
  }

  // ── Derived display list (prepend welcome when empty) ──────────────────────
  const displayMessages: ChatMessage[] =
    messages.length === 0 && !initialLoading ? [WELCOME_MESSAGE] : messages;

  // ── Render a single chat bubble ────────────────────────────────────────────
  function renderBubble({ item }: { item: ChatMessage }) {
    const isUser = item.role === "user";
    return (
      <View style={[s.bubbleWrapper, isUser ? s.bubbleWrapperUser : s.bubbleWrapperAI]}>
        {!isUser && (
          <View style={s.aiAvatar}>
            <Ionicons name="chatbubble-ellipses" size={14} color={Colors.primary} />
          </View>
        )}
        <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAI]}>
          <Text style={[s.bubbleText, isUser ? s.bubbleTextUser : s.bubbleTextAI]}>
            {item.text}
          </Text>
        </View>
      </View>
    );
  }

  // ── Loading indicator bubble ───────────────────────────────────────────────
  function LoadingBubble() {
    return (
      <View style={[s.bubbleWrapper, s.bubbleWrapperAI]}>
        <View style={s.aiAvatar}>
          <Ionicons name="chatbubble-ellipses" size={14} color={Colors.primary} />
        </View>
        <View style={[s.bubble, s.bubbleAI, s.loadingBubble]}>
          <View style={s.dotsRow}>
            <View style={s.dot} />
            <View style={s.dot} />
            <View style={s.dot} />
          </View>
          <Text style={s.thinkingText}>Thinking...</Text>
        </View>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.white} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Ionicons name="chatbubble-ellipses-outline" size={20} color={Colors.white} />
          <Text style={s.headerTitle}>MediGuard AI</Text>
        </View>
        <View style={s.headerSpacer} />
      </View>

      {/* Chat list */}
      {initialLoading ? (
        <View style={s.initLoader}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={s.initLoaderText}>Loading conversation...</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={displayMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderBubble}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={loading ? <LoadingBubble /> : null}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
        />
      )}

      {/* Quick question chips */}
      <View style={s.chipsContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chipsScroll}
        >
          {QUICK_QUESTIONS.map((q) => (
            <TouchableOpacity
              key={q}
              style={s.chip}
              onPress={() => sendMessage(q)}
              disabled={loading}
            >
              <Text style={s.chipText} numberOfLines={1}>
                {q}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Input bar */}
      <View style={s.inputBar}>
        <TextInput
          style={s.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="Ask a question..."
          placeholderTextColor={Colors.textSecondary}
          returnKeyType="send"
          onSubmitEditing={() => sendMessage()}
          multiline
          editable={!loading}
        />
        <TouchableOpacity
          style={[
            s.sendBtn,
            (!input.trim() || loading) && s.sendBtnDisabled,
          ]}
          onPress={() => sendMessage()}
          disabled={!input.trim() || loading}
        >
          <Ionicons
            name="send"
            size={20}
            color={!input.trim() || loading ? "#BDBDBD" : Colors.white}
          />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },

  // Header
  header: {
    backgroundColor: Colors.primary,
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 52,
    paddingBottom: 14,
    paddingHorizontal: 16,
  },
  backBtn: {
    padding: 4,
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.white,
  },
  headerSpacer: {
    width: 32,
  },

  // Initial loader
  initLoader: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  initLoaderText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },

  // Message list
  listContent: {
    padding: 16,
    paddingBottom: 8,
    gap: 12,
  },

  // Bubble wrappers
  bubbleWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  bubbleWrapperUser: {
    justifyContent: "flex-end",
  },
  bubbleWrapperAI: {
    justifyContent: "flex-start",
  },

  // AI avatar
  aiAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primaryPale,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },

  // Bubbles
  bubble: {
    padding: 12,
    maxWidth: "75%",
  },
  bubbleUser: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    borderBottomRightRadius: 4,
    alignSelf: "flex-end",
  },
  bubbleAI: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    alignSelf: "flex-start",
    maxWidth: "80%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  bubbleTextUser: {
    color: Colors.white,
  },
  bubbleTextAI: {
    color: Colors.textPrimary,
  },

  // Loading bubble
  loadingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: Colors.primaryLight,
  },
  thinkingText: {
    fontSize: 13,
    fontStyle: "italic",
    color: Colors.textSecondary,
  },

  // Quick chips
  chipsContainer: {
    borderTopWidth: 1,
    borderTopColor: "#E0E0E0",
    backgroundColor: Colors.bg,
    paddingVertical: 10,
  },
  chipsScroll: {
    paddingHorizontal: 16,
    gap: 8,
  },
  chip: {
    backgroundColor: Colors.primaryPale,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: "#C8E6C9",
    maxWidth: 240,
  },
  chipText: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: "500",
  },

  // Input bar
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingBottom: Platform.OS === "ios" ? 28 : 12,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: "#E0E0E0",
  },
  textInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    backgroundColor: Colors.bg,
    borderRadius: 21,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: "#C8E6C9",
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    backgroundColor: "#EEEEEE",
  },
});
