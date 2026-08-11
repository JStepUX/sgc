import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelRightClose, PanelRightOpen, Split } from 'lucide-react';
import { DEFAULT_PERSONA } from './lib/prompt';
import { newestDynamicState } from './lib/dynamic-state';
import { PROVIDER_LABEL } from './lib/provider';
import { isDesktop } from './lib/desktop';
import { AuroraBackground } from './components/AuroraBackground';
import { PhaseBar } from './components/PhaseBar';
import { MemoryPanel } from './components/MemoryPanel';
import { TurnInspector } from './components/TurnInspector';
import { TokenChart } from './components/TokenChart';
import { AssistantMessage } from './components/AssistantMessage';
import { UserPill } from './components/UserPill';
import { Composer } from './components/Composer';
import { ChatHistoryModal } from './components/ChatHistoryModal';
import { BrainManagerModal } from './components/BrainManagerModal';
import { ConfirmPersonaModal } from './components/ConfirmPersonaModal';
import { ConstitutionalEditorModal } from './components/ConstitutionalEditorModal';
import { DynamicStateModal } from './components/DynamicStateModal';
import { PromptEditorModal } from './components/PromptEditorModal';
import { ProviderConfigModal } from './components/ProviderConfigModal';
import { EditResponseModal } from './components/EditResponseModal';
import { useAuroraPulse } from './hooks/useAuroraPulse';
import { useRailCollapse } from './hooks/useRailCollapse';
import { useProvider } from './hooks/useProvider';
import { useChatSession } from './hooks/useChatSession';
import { useStateCalls } from './hooks/useStateCalls';
import { useTurnRunner } from './hooks/useTurnRunner';
import { useResponseEditor } from './hooks/useResponseEditor';
import { useTurnUndo } from './hooks/useTurnUndo';
import { useMemoryEditSync } from './hooks/useMemoryEditSync';
import { useTangent } from './hooks/useTangent';

// ============================================================
// SALIENCE-GATED COGNITION — Phase 1.5
// Ephemeral Sal + TF-IDF Cosine Grep + 2-Turn Local Buffer
// No model-based retrieval. One reasoning component, rebuilt fresh each turn.
//
// This file is the COMPOSITION ROOT only: it wires the per-axis hooks
// (./hooks — session, turn runner, response editor, provider, aurora, rail)
// into the per-file components (./components) and owns nothing but modal
// open/close flags and cross-hook glue. The pure logic (TF-IDF engine, prompt
// builder, transport) lives in ./lib. Styling is Tailwind v4 utilities +
// shadcn/ui primitives; the design tokens and aurora CSS live in index.css.
// The architecture and the Phase 1.5 invariants above are untouched.
// ============================================================

export default function SalienceGatedCognition() {
  // Modal open/close flags — pure UI choreography, so they stay on the root.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [constitutionalEditorOpen, setConstitutionalEditorOpen] = useState(false);
  const [brainManagerOpen, setBrainManagerOpen] = useState(false);
  const [dynamicStateOpen, setDynamicStateOpen] = useState(false);

  // Composer reset signal: bumped after a successful submit (and after a chat
  // reset) to clear + refocus the textarea inside Composer. Owned here because
  // both the session (startNewChat) and the turn runner (processInput) bump it.
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const bumpComposerReset = useCallback(() => setComposerResetSignal((s) => s + 1), []);

  // Stable modal handlers so the memoized children (Composer, MemoryPanel)
  // don't get a new onClick on every parent render.
  const handleToggleHistory = useCallback(() => setHistoryOpen((o) => !o), []);
  const handleCloseHistory = useCallback(() => setHistoryOpen(false), []);
  const handleOpenPromptEditor = useCallback(() => setPromptEditorOpen(true), []);
  const handleOpenConstitutionalEditor = useCallback(() => setConstitutionalEditorOpen(true), []);
  const handleOpenBrainManager = useCallback(() => setBrainManagerOpen(true), []);
  const handleCloseBrainManager = useCallback(() => setBrainManagerOpen(false), []);
  const handleOpenDynamicState = useCallback(() => setDynamicStateOpen(true), []);
  const handleCloseDynamicState = useCallback(() => setDynamicStateOpen(false), []);

  // --- The axes (see each hook's header for its contract) ---
  const aurora = useAuroraPulse();
  const { railCollapsed, toggleRail } = useRailCollapse();
  const providerState = useProvider();
  const session = useChatSession({
    onSessionReset: bumpComposerReset,
    onChatSwitched: handleCloseHistory,
  });
  // The shared reflecting registry — both state-turn producers report into it;
  // the rail reads the ACTIVE chat's count only, so another chat's slow call
  // can't mark this one as reflecting.
  const stateCalls = useStateCalls();
  const reflecting = stateCalls.inFlightFor(session.chatId);
  const runner = useTurnRunner(session, providerState, bumpComposerReset, stateCalls);
  const editor = useResponseEditor(session, providerState, stateCalls);
  const { undoLatestTurn } = useTurnUndo(session);
  const memorySync = useMemoryEditSync(session);
  const tangentAxis = useTangent(session);
  // Wipe is destructive → inline confirm (UI choreography, so root-owned).
  // Reset whenever the tangent closes by ANY path (resolve, chat switch,
  // Begin again) so a later tangent never opens straight into the confirm.
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  useEffect(() => {
    if (session.tangent === null) setWipeConfirmOpen(false);
  }, [session.tangent]);
  // The state the next prompt will actually read (D13) — shown as "carried"
  // when the latest turn has none, and the modal's seed when repairing one.
  const carriedState = useMemo(() => newestDynamicState(session.chatLog), [session.chatLog]);

  // Turn undo: the pair is deleted (persist-first, inside the hook) and the
  // removed user text is seeded back into the composer for editing. The seed
  // rides a monotonic nonce, same shape as composerResetSignal.
  const [composerSeed, setComposerSeed] = useState({ text: '', nonce: 0 });
  const handleUndoTurn = useCallback(async () => {
    const restored = await undoLatestTurn();
    if (restored !== null) {
      setComposerSeed((s) => ({ text: restored, nonce: s.nonce + 1 }));
    }
  }, [undoLatestTurn]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, runner.streamingText]);

  // "Begin again" doesn't create a chat immediately — it opens the Confirm
  // Persona modal first. Both entry points (PhaseBar onReset, the history
  // modal's Begin again) route here. Close the history modal if it's open so
  // the persona modal is the only thing on screen.
  const openPersonaModal = useCallback(() => {
    setHistoryOpen(false);
    setPersonaModalOpen(true);
  }, []);

  // Confirm from the persona modal: do the new-chat work with the chosen
  // persona + mask + brains to mount, then close the modal. (startNewChat
  // destructured so the dependency is the stable callback, not the per-render
  // session object.)
  const { startNewChat } = session;
  const confirmPersona = useCallback(
    async (persona: string, mask: string, brainIds: string[], constitutional: string) => {
      setPersonaModalOpen(false);
      await startNewChat(persona, mask, brainIds, constitutional);
    },
    [startNewChat],
  );

  return (
    <div className="relative h-screen w-full overflow-hidden bg-ground font-sans text-fg-1">
      <AuroraBackground
        gate={aurora.gate}
        active={aurora.typing || runner.isProcessing}
        pulseKey={aurora.pulseKey}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        <PhaseBar
          processing={runner.isProcessing}
          onReset={openPersonaModal}
          provider={providerState.provider}
          health={providerState.health}
          onSelectProvider={providerState.selectProvider}
          onConfigureProvider={providerState.configureProvider}
        />

        <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Thread. The tangent wash tints the WHOLE column (scroll area,
              resolution strip, composer) — tinting only the scroll region
              leaves the composer on an untinted band with a visible seam. */}
          <div
            className={`relative z-10 flex min-h-0 min-w-0 flex-1 flex-col transition-colors duration-500 ${
              session.tangent !== null ? 'bg-ember/[0.045]' : ''
            }`}
          >
            <div className="sal-scroll flex-1 overflow-x-hidden overflow-y-auto pt-[30px] pb-3">
              <div className="mx-auto flex max-w-[680px] flex-col gap-[18px] px-8">
                {session.messages.length === 0 && (
                  <div className="mx-auto mt-[12vh] max-w-[440px] text-center text-pretty text-sm leading-[1.7] text-fg-3">
                    A local buffer holds what's near; cosine grep reaches for what's
                    far. The only mind here is Sal — and Sal begins again every turn.
                  </div>
                )}

                {(() => {
                  // The pencil lives only on the latest assistant reply (scope:
                  // latest turn only). canEdit gates on a persisted id + no turn
                  // in flight, so Save always has an addressable target.
                  let lastAssistantIdx = -1;
                  for (let i = session.messages.length - 1; i >= 0; i--) {
                    // Skip timeless manual memories — the pencil is for streamed replies.
                    if (session.messages[i].role === 'assistant' && !session.messages[i].timeless) { lastAssistantIdx = i; break; }
                  }
                  // A tangent open with ZERO tangent pairs: the latest turn is
                  // still CANON, so undo/pencil must not reach across the
                  // boundary (spec 04, D6 — the only guard the tangent needs).
                  const tangentAtZero = session.tangent !== null
                    && session.messages.length === session.tangent.canonEntries;
                  const nodes = session.messages.map((msg, i) =>
                    msg.role === 'user'
                      ? <UserPill key={i} text={msg.content} />
                      : <AssistantMessage
                          key={i}
                          text={msg.content}
                          label={session.activeMask}
                          summary={msg.summary}
                          spontaneity={msg.spontaneity}
                          onEdit={i === lastAssistantIdx ? editor.openLatestEditor : undefined}
                          canEdit={i === lastAssistantIdx && !runner.isProcessing && typeof msg.id === 'number' && !tangentAtZero}
                          onUndo={i === lastAssistantIdx ? handleUndoTurn : undefined}
                          canUndo={i === lastAssistantIdx && !runner.isProcessing && typeof msg.id === 'number' && !tangentAtZero}
                        />,
                  );
                  // Boundary divider — tangent entries are always the visible
                  // tail, so it sits at index canonEntries (equal to length on
                  // a fresh tangent: the divider then closes the thread).
                  if (session.tangent !== null) {
                    nodes.splice(session.tangent.canonEntries, 0, (
                      <div
                        key="tangent-divider"
                        role="separator"
                        aria-label="Tangent begins"
                        className="flex items-center gap-3 py-1"
                      >
                        <div className="h-px flex-1 bg-ember/40" />
                        <span className="font-mono text-[10px] tracking-[0.18em] text-ember/90">TANGENT</span>
                        <div className="h-px flex-1 bg-ember/40" />
                      </div>
                    ));
                  }
                  return nodes;
                })()}

                {runner.streamingText !== null && (
                  <AssistantMessage text={runner.streamingText || ' '} streaming label={session.activeMask} />
                )}

                {/* Dot-pulse loader: shown only before the first streamed token. */}
                {runner.isProcessing && runner.streamingText === null && (
                  <div className="flex gap-[5px] py-1">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="size-1.5 rounded-full bg-fg-3 animate-loader-dot"
                        style={{ animationDelay: `${d * 0.2}s` }}
                      />
                    ))}
                  </div>
                )}

                {/* Quiet status line while a deliberate-recall round-trip is in
                    flight — rendered UNDER any already-streamed text so the
                    partial reply stays visible while Sal remembers. Diegetic
                    copy only (never "grep" / "tool call"). */}
                {runner.turnStatus === 'remembering' && (
                  <div className="animate-pulse py-1 font-mono text-[10.5px] tracking-wide text-fg-3">
                    Remembering…
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>
            </div>

            {/* Tangent resolution strip (spec 04, D7). Both actions disable
                mid-stream: an in-flight pair hasn't persisted yet, so resolving
                under it would let the pair land AFTER the boundary cleared and
                silently become canon. */}
            {session.tangent !== null && (
              <div className="mx-auto w-full max-w-[680px] px-8">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[16px] border border-ember/45 bg-ember/[0.07] px-4 py-2 backdrop-blur-[10px]">
                  <Split className="size-[13px] shrink-0 text-ember" />
                  <span className="font-mono text-[11px] tracking-[0.04em] text-ember">
                    Ephemeral tangent · {tangentAxis.tangentTurns} {tangentAxis.tangentTurns === 1 ? 'turn' : 'turns'}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {wipeConfirmOpen ? (
                      <>
                        <span className="text-[11.5px] text-fg-2">
                          Wipe {tangentAxis.tangentTurns === 1 ? 'this turn' : `these ${tangentAxis.tangentTurns} turns`} permanently?
                        </span>
                        <button
                          type="button"
                          onClick={() => { setWipeConfirmOpen(false); void tangentAxis.wipe(); }}
                          disabled={runner.isProcessing || tangentAxis.resolving}
                          className="rounded-full border border-ember bg-ember/15 px-3 py-1 font-mono text-[11px] text-ember transition-colors hover:bg-ember hover:text-bone disabled:opacity-40"
                        >
                          Wipe
                        </button>
                        <button
                          type="button"
                          onClick={() => setWipeConfirmOpen(false)}
                          className="rounded-full border border-hairline-strong px-3 py-1 font-mono text-[11px] text-fg-2 transition-colors hover:border-ember hover:text-ember"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void tangentAxis.makeCanon()}
                          disabled={runner.isProcessing || tangentAxis.resolving}
                          className="rounded-full border border-hairline-strong px-3 py-1 font-mono text-[11px] text-fg-2 transition-colors hover:border-ember hover:text-ember disabled:opacity-40"
                        >
                          Make canon
                        </button>
                        <button
                          type="button"
                          onClick={() => setWipeConfirmOpen(true)}
                          disabled={runner.isProcessing || tangentAxis.resolving}
                          className="rounded-full border border-hairline-strong px-3 py-1 font-mono text-[11px] text-fg-2 transition-colors hover:border-ember hover:text-ember disabled:opacity-40"
                        >
                          Wipe…
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            <Composer
              onSubmit={runner.submitTurn}
              onKeystroke={aurora.handleKeystroke}
              submitDisabled={runner.isProcessing || !session.hydrated || !session.chatId || tangentAxis.resolving}
              resetSignal={composerResetSignal}
              seed={composerSeed}
              historyOpen={historyOpen}
              onToggleHistory={handleToggleHistory}
              historyButtonRef={historyButtonRef}
              tangentOpen={session.tangent !== null}
              canBeginTangent={tangentAxis.canBegin && !runner.isProcessing}
              onBeginTangent={tangentAxis.begin}
            />
          </div>

          {/* Context-rail collapse toggle — a small tab pinned to the chat/rail
              seam. Desktop only (hidden lg:flex); its `right` offset animates in
              lockstep with the rail's width so the tab rides the closing edge. */}
          <button
            type="button"
            onClick={toggleRail}
            aria-label={railCollapsed ? 'Show context rail' : 'Hide context rail'}
            aria-expanded={!railCollapsed}
            className={`absolute top-1/2 z-30 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 transition-[right,color,border-color] duration-300 ease-out hover:border-ember hover:text-ember lg:flex ${
              railCollapsed ? 'right-2' : 'right-[346px]'
            }`}
          >
            {railCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
          </button>

          {/* Context rail */}
          <aside
            className={`sal-scroll relative z-20 flex max-h-[45vh] w-full flex-col gap-7 overflow-y-auto border-t border-hairline px-6 pt-[26px] pb-8 lg:h-full lg:max-h-none lg:shrink-0 lg:border-t-0 lg:border-l lg:transition-[width,opacity] lg:duration-300 lg:ease-out ${
              railCollapsed
                ? 'lg:w-0 lg:overflow-hidden lg:border-l-0 lg:px-0 lg:opacity-0 lg:pointer-events-none'
                : 'lg:w-[360px] lg:opacity-100'
            }`}
          >
            <MemoryPanel
              constitutional={session.constitutional}
              onOpenEditor={handleOpenConstitutionalEditor}
              editorDisabled={!session.chatId}
              promptVersionN={session.promptVersions.length > 0 ? session.promptVersions[0].n : 1}
              onOpenPromptEditor={handleOpenPromptEditor}
              promptEditorDisabled={!session.chatId}
              mountedBrains={session.mountedBrains.map((p) => ({
                id: p.id,
                name: p.name,
                stub: p.source.stub,
                chunkCount: p.chunks.length,
              }))}
              onOpenBrainManager={handleOpenBrainManager}
              brainsDisabled={!session.chatId}
            />
            <TurnInspector
              turnData={session.latestTurn}
              stateInFlight={reflecting}
              onOpenStateEditor={handleOpenDynamicState}
              stateEditorDisabled={!editor.canEditDynamicState || reflecting}
              carriedState={carriedState}
            />
            <TokenChart tokenHistory={session.tokenHistory} />
          </aside>
        </div>
      </div>

      <ChatHistoryModal
        open={historyOpen}
        onClose={handleCloseHistory}
        chats={session.chats}
        activeChatId={session.chatId}
        onSelect={session.loadChat}
        onDelete={session.deleteChat}
        onBeginAgain={openPersonaModal}
        onActiveTurnsChanged={memorySync.onActiveTurnsChanged}
        onTurnsMutated={memorySync.onTurnsMutated}
        returnFocusRef={historyButtonRef}
      />

      <ConfirmPersonaModal
        open={personaModalOpen}
        defaultPersona={DEFAULT_PERSONA}
        currentConstitutional={session.constitutional}
        onConfirm={confirmPersona}
        onCancel={() => setPersonaModalOpen(false)}
      />

      <ConstitutionalEditorModal
        open={constitutionalEditorOpen}
        text={session.constitutional}
        onSave={session.setConstitutional}
        onClose={() => setConstitutionalEditorOpen(false)}
      />

      <DynamicStateModal
        open={dynamicStateOpen}
        // Seed from the state that is actually LIVE (the latest turn's, else
        // the carried one) — repairing a failed state call should start from
        // what Sal will otherwise feel, not from blank fields.
        state={session.latestTurn?.dynamicState ?? carriedState}
        onSave={editor.saveDynamicState}
        onClose={handleCloseDynamicState}
      />

      <BrainManagerModal
        open={brainManagerOpen}
        onClose={handleCloseBrainManager}
        mountedBrainIds={session.mountedBrains.map((p) => p.id)}
        onSetMounted={session.setMountedBrainIds}
      />

      <PromptEditorModal
        open={promptEditorOpen}
        onClose={() => setPromptEditorOpen(false)}
        livePersona={session.activePersona}
        versions={session.promptVersions}
        onSave={session.savePromptVersion}
      />

      <ProviderConfigModal
        open={providerState.providerConfig !== null}
        provider={providerState.providerConfig?.provider ?? 'anthropic'}
        label={PROVIDER_LABEL[providerState.providerConfig?.provider ?? 'anthropic']}
        configState={providerState.desktopConfigState}
        mode={isDesktop() ? 'desktop' : 'web'}
        onSave={providerState.saveProviderConfig}
        onCancel={providerState.closeProviderConfig}
      />

      <EditResponseModal
        open={editor.editTarget !== null}
        onClose={editor.closeEditor}
        initialText={editor.editTarget?.content ?? ''}
        label={session.activeMask}
        canRespin={Boolean(providerState.health?.providers[providerState.provider]?.available) && !runner.isProcessing}
        firedOperatorLabel={editor.firedOperatorLabel}
        onRespin={editor.respin}
        onSave={editor.saveEdit}
      />
    </div>
  );
}
