-------------------------- MODULE CaptureRemovalLedger --------------------------
(***************************************************************************)
(* The capture removal ledger: how sealant decides, under the drain record  *)
(* of one run (`workspace_capture_drains`), that the run's executor may be  *)
(* removed, and keeps everyone else off it while the runtime removes it.    *)
(*                                                                         *)
(* The promise: an executor is removed only on the evidence about it that  *)
(* is current, with no observation of it in flight, and nothing is asked   *)
(* of it (no observation, no recovery) between that decision and the      *)
(* runtime removing it. The harm when it breaks: an executor whose disk    *)
(* holds work nobody saved is deleted, and the work is lost.               *)
(*                                                                         *)
(* One step of this model is one transaction of the ledger                 *)
(* (`WorkspaceCaptureDrainRepoLive` in                                     *)
(* packages/db/src/repositories/workspace-capture-drains.ts; the in-memory *)
(* ledger in capture-drain.ts keeps the same contract, sealant#671), or    *)
(* one call to the runtime. Each action names the code it mirrors.         *)
(* README.md beside this file is the record: bounds, assumptions, results. *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Deleters,         \* stop job, runtime-exit reconciler, orphan reaper: `deleteOnEvidence`
    Observers,        \* drain worker, API flush and status routes: one observation each
    RecoveryActors,   \* {} or one recovery sweep attempt (`recover-retained-executors.ts`)
    MaxTokens,        \* removal tokens minted (authorizations and reissues together)
    MaxAttests,       \* completion attestations: evidence that moves without asking the executor
    MaxCrashes,       \* processes that die mid-step (deleters and observers together)
    \* Timing the code relies on (README, "Assumptions"): a deleter that wrote `issueDeletion`
    \* sends its runtime call before the runtime's bound on a request (`removalFenceMs`) passes.
    \* TRUE lets the issuer stall past it.
    SendMayOutliveBound,
    \* main's choices, substituted from the `Code…` definitions below; the broken cases set them.
    IssueChecksEvidence,
    ReauthNeedsCurrentDecision,
    OpenRefusedWhileIssued,
    OpenRefusedWhenDeleted,
    ReleaseWaitsForUnknown,
    ReleaseNeedsBound,
    CompleteOnlyOnSuccess,
    AuthorizeRefusesDeleted,
    AuthorizeChecksRecovery,
    \* The drain label (`workspace_capture_drains.state`).
    StopJobs,         \* the deleters that are the stop job: they hold the drain claim, write `stop-failed`
    Drains,           \* the observers that are drains: under the drain claim, they `save` a label
    LabelRanked,              \* recordObservation: a terminal label never replaces a stronger one
    UnrankedKeepsTerminal,    \* the proposed fix: markRetained and `stop-failed` keep a terminal label
    SaveKeepsTerminal,        \* a drain's `save` (recordProgress) keeps a terminal label (SLNT-978)
    MissingNeedsGoneRuntime,  \* a removal on basis `missing` only once the runtime said it has nothing
    TrackLabel        \* FALSE: the label and the drain claim are left out (the removal cases' bounds)

\* main's code, as `WorkspaceCaptureDrainRepoLive` writes it.
CodeIssueChecksEvidence == TRUE        \* issueDeletion: `deletionEvidenceCurrent` before every request
CodeReauthNeedsCurrentDecision == TRUE \* reconcileIssuedDeletion: `reauthorizedVersion === evidenceVersion`
CodeOpenRefusedWhileIssued == TRUE     \* openObservation: `deleting-issued` refused whatever its hold
CodeOpenRefusedWhenDeleted == TRUE     \* openObservation: `deleted` refused
CodeReleaseWaitsForUnknown == TRUE     \* releaseDeletion: an unknown request keeps it issued
CodeReleaseNeedsBound == TRUE          \* reconcileIssuedDeletion: `released` only when `fenced`
CodeCompleteOnlyOnSuccess == TRUE      \* removeUnderDeletion: completeDeletion on the call's success only
CodeAuthorizeRefusesDeleted == TRUE    \* authorizeDeletion: `deleted` answers deleted
CodeAuthorizeChecksRecovery == TRUE    \* authorizeDeletion: `recovering` under another's live claim
CodeLabelRanked == TRUE                \* recordObservation: `drainLabelsOutranking`
CodeUnrankedKeepsTerminal == FALSE     \* markRetained, `stop-failed`: write the state whatever it was
CodeSaveKeepsTerminal == TRUE          \* recordProgress: `drainLabelsKeptOverProgress`
CodeMissingNeedsGoneRuntime == TRUE    \* decideExecutorDeletion: `missing` only on the runtime's word

Actors == Deleters \cup RecoveryActors
Tokens == 1..MaxTokens
NoTok == 0

\* A step that only writes the drain label: skipped when the label is left out (TrackLabel).
LabelStep(x) == IF TrackLabel THEN x ELSE "done"

VARIABLES
    \* The ledger row.
    \* evidence_version is not a number here: each stored version is a flag, TRUE while it is
    \* still the current one. Every comparison the code makes is with the current version.
    fence,       \* observation_fences, by observer: none, open, or lapsed (TTL passed or ended)
    lapsedAt,    \* for each open fence, the fences already lapsed when it was opened
    dstate,      \* deletion_state: none, deleting, issued (deleting-issued), deleted
    dtok,        \* deletion_token
    dcur,        \* deletion_evidence_version = evidence_version
    dlive,       \* deletion_expires_at > now()
    reqs,        \* deletion_requests: each token's request outcome
    lastIssued,  \* the request deletion_issued_at belongs to
    rec,         \* recovery_lease_*: none, live, lapsed
    label,       \* state: the drain label (none, draining, saved, kept, stop-failed, gone, stopped)
    claimBy,     \* lease_owner: who holds the run's drain claim (`ledger.claim`), or none
    \* The runtime.
    exec,        \* present or gone
    rt,          \* each request as the runtime has it: none, pending, acted, refused
    elapsed,     \* the runtime's bound on the request, from when it was recorded issued, has passed
    late,        \* the request was sent after that (SendMayOutliveBound): the bound does not hold it
    \* The processes.
    pc, tok, seenCur, seenRt, wantDelete,  \* seenCur: the version the actor read is current
    admitted,    \* the recovery attempt was admitted (it decides once before, once after)
    opc,
    \* Budgets.
    nextTok, attests, crashes,
    \* Ghosts: what the invariants read. Nothing in the code reads them.
    askedSince,  \* an observation was opened or a recovery admitted since the token's request was issued
    basisCur,    \* the evidence version the decision behind each token was made on is current
    issuedL,     \* the token's request was recorded issued
    sentOk,      \* that version was current, with nothing in flight, when the request was issued
    everDeleted, \* the row was once recorded deleted
    bad          \* events the invariants forbid, as they happened

ledgerVars == <<fence, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued, rec>>
runtimeVars == <<exec, rt, elapsed, late>>
actorVars == <<pc, tok, seenCur, seenRt, wantDelete, admitted>>
ghostVars == <<askedSince, basisCur, issuedL, sentOk, everDeleted, bad>>
labelVars == <<label, claimBy>>
vars == <<ledgerVars, runtimeVars, actorVars, opc, nextTok, attests, crashes, ghostVars, labelVars>>

PCs == {"sclaim", "claim", "admit", "look", "read", "auth", "settle", "issue", "send", "await",
        "retain", "failed", "label", "missing", "done", "end"}
Labels == {"none", "draining", "saved", "kept", "stop-failed", "gone", "stopped"}

TypeOK ==
    /\ fence \in [Observers -> {"none", "open", "lapsed"}]
    /\ lapsedAt \in [Observers -> SUBSET Observers]
    /\ dstate \in {"none", "deleting", "issued", "deleted"}
    /\ dtok \in Tokens \cup {NoTok}
    /\ dcur \in BOOLEAN
    /\ dlive \in BOOLEAN
    /\ reqs \in [Tokens -> {"none", "unknown", "refused", "done", "fenced"}]
    /\ lastIssued \in Tokens \cup {NoTok}
    /\ rec \in {"none", "live", "lapsed"}
    /\ label \in Labels
    /\ claimBy \in StopJobs \cup Drains \cup {"none"}
    /\ exec \in {"present", "gone"}
    /\ rt \in [Tokens -> {"none", "pending", "acted", "refused"}]
    /\ elapsed \in [Tokens -> BOOLEAN]
    /\ late \in [Tokens -> BOOLEAN]
    /\ pc \in [Actors -> PCs]
    /\ tok \in [Actors -> Tokens \cup {NoTok}]
    /\ seenCur \in [Actors -> BOOLEAN]
    /\ seenRt \in [Actors -> {"present", "gone"}]
    /\ wantDelete \in [Actors -> BOOLEAN]
    /\ admitted \in BOOLEAN
    /\ opc \in [Observers -> {"idle", "claimed", "asked", "save", "done"}]
    /\ nextTok \in 0..MaxTokens
    /\ askedSince \in [Tokens -> BOOLEAN]
    /\ basisCur \in [Tokens -> BOOLEAN]
    /\ issuedL \in [Tokens -> BOOLEAN]
    /\ sentOk \in [Tokens -> BOOLEAN]
    /\ everDeleted \in BOOLEAN
    /\ bad \subseteq {"stale-act", "untracked-act", "over-recovery", "asked-deleted",
                      "label-weakened"}

Init ==
    /\ fence = [o \in Observers |-> "none"]
    /\ lapsedAt = [o \in Observers |-> {}]
    /\ dstate = "none" /\ dtok = NoTok /\ dcur = FALSE /\ dlive = FALSE
    /\ reqs = [t \in Tokens |-> "none"]
    /\ lastIssued = NoTok
    /\ rec = "none"
    /\ label = "none" /\ claimBy = "none"
    /\ exec = "present"
    /\ rt = [t \in Tokens |-> "none"]
    /\ elapsed = [t \in Tokens |-> FALSE]
    /\ late = [t \in Tokens |-> FALSE]
    /\ pc = [a \in Actors |-> IF a \in RecoveryActors THEN "claim"
                             ELSE IF a \in StopJobs /\ TrackLabel THEN "sclaim" ELSE "look"]
    /\ tok = [a \in Actors |-> NoTok]
    /\ seenCur = [a \in Actors |-> FALSE]
    /\ seenRt = [a \in Actors |-> "present"]
    /\ wantDelete = [a \in Actors |-> FALSE]
    /\ admitted = FALSE
    /\ opc = [o \in Observers |-> "idle"]
    /\ nextTok = 0 /\ attests = 0 /\ crashes = 0
    /\ askedSince = [t \in Tokens |-> FALSE]
    /\ basisCur = [t \in Tokens |-> FALSE]
    /\ issuedL = [t \in Tokens |-> FALSE]
    /\ sentOk = [t \in Tokens |-> TRUE]
    /\ everDeleted = FALSE
    /\ bad = {}

-----------------------------------------------------------------------------
(* Ledger helpers.                                                         *)

NoFence == \A o \in Observers : fence[o] = "none"

\* `deletionEvidenceCurrent`: the removal's version is current and no observation is in flight.
DeletionCurrent == dcur /\ NoFence

\* `evidence_version + 1`: every version stored or read before is no longer current. The
\* action that bumps sets `dcur'` itself (Bump leaves it to it).
Bump ==
    /\ seenCur' = [a \in Actors |-> FALSE]
    /\ basisCur' = [t \in Tokens |-> FALSE]

\* NO_DELETION (voiding a removal not yet issued; giving one up).
NoDeletion ==
    /\ dstate' = "none" /\ dtok' = NoTok /\ dcur' = FALSE /\ dlive' = FALSE
    /\ reqs' = [t \in Tokens |-> "none"] /\ lastIssued' = NoTok

\* A bump that voids a removal not yet issued (`recordStatus`, `openObservation`,
\* `admitRecovery`) when `void`, and leaves the removal as it is otherwise.
BumpVoiding(void) ==
    /\ Bump
    /\ IF void THEN NoDeletion
       ELSE /\ dcur' = FALSE
            /\ UNCHANGED <<dstate, dtok, dlive, reqs, lastIssued>>

\* An observation was opened or a recovery admitted: it is asked after every request issued.
Ask == askedSince' = [t \in Tokens |-> askedSince[t] \/ issuedL[t]]

\* The runtime's bound has passed since the last issue and for every request of unknown outcome
\* (`fenced` in reconcileIssuedDeletion).
Fenced ==
    /\ lastIssued # NoTok /\ elapsed[lastIssued]
    /\ \A t \in Tokens : reqs[t] = "unknown" => elapsed[t]

-----------------------------------------------------------------------------
(* Deleters: `authorizedDeletion`, `settleIssuedRemoval`, `removeUnderDeletion`  *)
(* (capture-drain.ts). The recovery attempt, once admitted, is a deleter too,    *)
(* holding its claim (`recovery` passed to authorizeDeletion).                  *)

\* The caller's look at the runtime (`runtime`, the state `decide` weighs). Gone is final.
Look(a) ==
    /\ pc[a] = "look"
    /\ seenRt' = [seenRt EXCEPT ![a] = exec]
    /\ pc' = [pc EXCEPT ![a] = "read"]
    /\ UNCHANGED <<labelVars, ledgerVars, runtimeVars, tok, seenCur, wantDelete, admitted, opc, nextTok, attests,
                   crashes, ghostVars>>

\* `ledger.read`, then `decide` on what it read. A removal issued with no recorded outcome is
\* settled first (`removalIssued`); `decide` there only says whether the record as it stands
\* authorizes the same removal (`reauthorizedVersion`). Otherwise decide to remove (authorize)
\* or to keep (stop). `decide` is abstract: it may go either way on any record.
Read(a) ==
    /\ pc[a] = "read"
    /\ seenCur' = [seenCur EXCEPT ![a] = TRUE]
    /\ IF dstate = "issued"
         THEN /\ \E w \in BOOLEAN : wantDelete' = [wantDelete EXCEPT ![a] = w]
              /\ pc' = [pc EXCEPT ![a] = "settle"]
         ELSE /\ \E next \in {"auth", "keep", "missing"} :
                   /\ next = "missing" => (seenRt[a] = "gone" \/ ~MissingNeedsGoneRuntime)
                   \* `decideExecutorDeletion` never keeps an executor the runtime no longer has.
                   /\ next = "keep" => seenRt[a] = "present"
                   /\ pc' = [pc EXCEPT ![a] =
                            IF next = "auth" THEN "auth"
                            ELSE IF next = "missing" THEN LabelStep("missing")
                            \* Recovery kept it on its first decision: it asks to start it.
                            ELSE IF a \in RecoveryActors /\ ~admitted THEN "admit"
                            ELSE IF a \in RecoveryActors THEN "done"
                            \* Kept: recorded retained (`markRetained`).
                            ELSE LabelStep("retain")]
              /\ UNCHANGED wantDelete
    /\ UNCHANGED <<labelVars, ledgerVars, runtimeVars, tok, seenRt, admitted, opc, nextTok, attests, crashes,
                   ghostVars>>

\* authorizeDeletion: one transaction under the row lock.
Authorize(a) ==
    /\ pc[a] = "auth"
    /\ CASE dstate = "deleted" /\ AuthorizeRefusesDeleted ->
              \* `deleted`: the runtime call is repeated with nothing held (idempotent), and the
              \* removal recorded on the drain (`removalObservation`).
              /\ pc' = [pc EXCEPT ![a] = LabelStep("label")]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] dstate = "issued" ->
              \* `held` while its issuer holds it; `unresolved` otherwise: settled next attempt.
              /\ pc' = [pc EXCEPT ![a] = IF dlive THEN "done" ELSE "read"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] AuthorizeChecksRecovery /\ rec = "live" /\ a \notin RecoveryActors ->
              \* `recovering`: only the attempt holding the live claim removes it.
              /\ pc' = [pc EXCEPT ![a] = "done"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] dstate = "deleting" /\ dlive ->
              /\ pc' = [pc EXCEPT ![a] = "done"]   \* `held`
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] ~(seenCur[a] /\ NoFence) ->
              /\ pc' = [pc EXCEPT ![a] = "read"]   \* `changed`: decide again
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] nextTok = MaxTokens ->
              /\ pc' = [pc EXCEPT ![a] = "done"]   \* the model's token budget is spent
              /\ UNCHANGED <<ledgerVars, tok, nextTok, basisCur, bad>>
         [] OTHER ->
              LET t == nextTok + 1 IN
              /\ nextTok' = t
              /\ dstate' = "deleting" /\ dtok' = t /\ dcur' = TRUE /\ dlive' = TRUE
              /\ reqs' = [u \in Tokens |-> "none"] /\ lastIssued' = NoTok
              /\ tok' = [tok EXCEPT ![a] = t]
              /\ basisCur' = [basisCur EXCEPT ![t] = TRUE]
              /\ bad' = IF rec = "live" /\ a \notin RecoveryActors
                          THEN bad \cup {"over-recovery"} ELSE bad
              /\ pc' = [pc EXCEPT ![a] = "issue"]
              /\ UNCHANGED <<fence, lapsedAt, rec>>
    /\ UNCHANGED <<labelVars, runtimeVars, seenCur, seenRt, wantDelete, admitted, opc, attests, crashes, askedSince,
                   issuedL, sentOk, everDeleted>>

\* What reconcileIssuedDeletion reissues on: the evidence the removal was authorized on stands,
\* or the caller's decision on the record it read authorizes the same removal at the current
\* version (`reauthorizedVersion`). Broken: re-based whatever version that decision was made on.
StandsAgain(a) == DeletionCurrent
Reauthorized(a) ==
    wantDelete[a] /\ NoFence /\ (ReauthNeedsCurrentDecision => seenCur[a])

\* reconcileIssuedDeletion, from the runtime state the caller saw (`seenRt`) and its decision.
Settle(a) ==
    /\ pc[a] = "settle"
    /\ CASE dstate = "deleted" ->                   \* `already-deleted`
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, seenCur, basisCur>>
         [] dstate # "issued" ->                     \* `none`
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, seenCur, basisCur>>
         [] dlive ->                                 \* `held`: kept
              /\ pc' = [pc EXCEPT ![a] = "done"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, seenCur, basisCur>>
         [] seenRt[a] = "gone" ->                    \* `deleted`, the version bumped
              /\ dstate' = "deleted" /\ dlive' = FALSE /\ dcur' = FALSE
              /\ Bump
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<fence, lapsedAt, dtok, reqs, lastIssued, rec, tok, nextTok>>
         [] (StandsAgain(a) \/ Reauthorized(a)) /\ nextTok = MaxTokens ->
              /\ pc' = [pc EXCEPT ![a] = "done"]      \* the model's token budget is spent
              /\ UNCHANGED <<ledgerVars, tok, nextTok, seenCur, basisCur>>
         [] StandsAgain(a) ->
              \* `reissue`: the evidence it was authorized on stands; taken over.
              LET t == nextTok + 1 IN
              /\ nextTok' = t /\ dtok' = t /\ dlive' = TRUE
              /\ tok' = [tok EXCEPT ![a] = t]
              /\ basisCur' = [basisCur EXCEPT ![t] = basisCur[dtok]]
              /\ pc' = [pc EXCEPT ![a] = "issue"]
              /\ UNCHANGED <<fence, lapsedAt, dstate, dcur, reqs, lastIssued, rec, seenCur>>
         [] Reauthorized(a) ->
              \* `reissue`, re-based on the current version.
              LET t == nextTok + 1 IN
              /\ nextTok' = t /\ dtok' = t /\ dlive' = TRUE /\ dcur' = TRUE
              /\ tok' = [tok EXCEPT ![a] = t]
              /\ basisCur' = [basisCur EXCEPT ![t] = seenCur[a]]
              /\ pc' = [pc EXCEPT ![a] = "issue"]
              /\ UNCHANGED <<fence, lapsedAt, dstate, reqs, lastIssued, rec, seenCur>>
         [] ReleaseNeedsBound /\ ~Fenced ->          \* `outstanding`: kept
              /\ pc' = [pc EXCEPT ![a] = "done"]
              /\ UNCHANGED <<ledgerVars, tok, nextTok, seenCur, basisCur>>
         [] OTHER ->
              \* `released`: every unknown request recorded fenced, the version bumped.
              /\ dstate' = "none" /\ dtok' = NoTok /\ dcur' = FALSE /\ dlive' = FALSE
              /\ reqs' = [t \in Tokens |-> IF reqs[t] = "unknown" THEN "fenced" ELSE reqs[t]]
              /\ lastIssued' = NoTok
              /\ Bump
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<fence, lapsedAt, rec, tok, nextTok>>
    /\ UNCHANGED <<labelVars, runtimeVars, seenRt, wantDelete, admitted, opc, attests, crashes, askedSince,
                   issuedL, sentOk, everDeleted, bad>>

\* issueDeletion, RIGHT BEFORE the runtime call. `false` sends nothing; `deleteOnEvidence`
\* decides again on what is current.
Issue(a) ==
    LET t == tok[a] IN
    /\ pc[a] = "issue"
    /\ CASE dtok # t \/ dstate \notin {"deleting", "issued"} ->
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<ledgerVars, issuedL, sentOk>>
         [] IssueChecksEvidence /\ ~DeletionCurrent ->
              \* Taken over as issued and the evidence moved: its hold ends now.
              /\ dlive' = IF dstate = "issued" THEN FALSE ELSE dlive
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<fence, lapsedAt, dstate, dtok, dcur, reqs, lastIssued, rec,
                             issuedL, sentOk>>
         [] reqs[t] # "none" ->                      \* a token sends one request
              /\ pc' = [pc EXCEPT ![a] = "read"]
              /\ UNCHANGED <<ledgerVars, issuedL, sentOk>>
         [] OTHER ->
              /\ dstate' = "issued" /\ dlive' = TRUE
              /\ reqs' = [reqs EXCEPT ![t] = "unknown"]
              /\ lastIssued' = t
              /\ issuedL' = [issuedL EXCEPT ![t] = TRUE]
              /\ sentOk' = [sentOk EXCEPT ![t] = basisCur[t] /\ NoFence]
              /\ pc' = [pc EXCEPT ![a] = "send"]
              /\ UNCHANGED <<fence, lapsedAt, dtok, dcur, rec>>
    /\ UNCHANGED <<labelVars, runtimeVars, tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok, attests,
                   crashes, askedSince, basisCur, everDeleted, bad>>

\* releaseDeletion(t): the request `t` sent was refused, or never made. No version bump.
Release(t) ==
    IF dstate \notin {"deleting", "issued"}
      THEN UNCHANGED <<dstate, dtok, dcur, dlive, reqs, lastIssued>>
      ELSE LET rs == [reqs EXCEPT ![t] = IF @ = "unknown" THEN "refused" ELSE @] IN
           CASE dtok # t ->
                  /\ reqs' = rs
                  /\ UNCHANGED <<dstate, dtok, dcur, dlive, lastIssued>>
             [] ReleaseWaitsForUnknown /\ \E u \in Tokens : rs[u] = "unknown" ->
                  /\ reqs' = rs /\ dlive' = FALSE
                  /\ UNCHANGED <<dstate, dtok, dcur, lastIssued>>
             [] OTHER ->
                  \* NO_DELETION, keeping the settled requests.
                  /\ dstate' = "none" /\ dtok' = NoTok /\ dcur' = FALSE /\ dlive' = FALSE
                  /\ reqs' = rs /\ lastIssued' = NoTok

\* The runtime call: the request reaches the runtime.
Send(a) ==
    /\ pc[a] = "send"
    /\ rt' = [rt EXCEPT ![tok[a]] = "pending"]
    /\ late' = [late EXCEPT ![tok[a]] = elapsed[tok[a]]]
    /\ pc' = [pc EXCEPT ![a] = "await"]
    /\ UNCHANGED <<labelVars, ledgerVars, exec, elapsed, tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok,
                   attests, crashes, ghostVars>>

\* The call failed before anything was sent (`isRemovalRefusal`: nothing was sent).
NotSent(a) ==
    /\ pc[a] = "send"
    /\ Release(tok[a])
    /\ pc' = [pc EXCEPT ![a] = LabelStep("failed")]
    /\ UNCHANGED <<labelVars, fence, lapsedAt, rec, runtimeVars, tok, seenCur, seenRt, wantDelete, admitted,
                   opc, nextTok, attests, crashes, ghostVars>>

\* confirmDeletion, the hold renewed while the call runs; a lapsed hold is live again.
Renew(a) ==
    /\ pc[a] \in {"send", "await"}
    /\ dtok = tok[a] /\ ~dlive
    /\ dstate = "issued" \/ (dstate = "deleting" /\ DeletionCurrent)
    /\ dlive' = TRUE
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, reqs, lastIssued, rec, runtimeVars,
                   actorVars, opc, nextTok, attests, crashes, ghostVars>>

\* completeDeletion: the runtime call succeeded. Written whoever holds it; the version bumped.
Succeed(a) ==
    LET t == tok[a] IN
    /\ pc[a] = "await"
    /\ rt[t] = "acted" \/ (~CompleteOnlyOnSuccess /\ rt[t] = "pending")
    /\ dstate' = "deleted" /\ dtok' = t /\ dlive' = FALSE /\ dcur' = FALSE
    /\ reqs' = [reqs EXCEPT ![t] = IF @ = "unknown" THEN "done" ELSE @]
    /\ Bump
    /\ everDeleted' = TRUE
    /\ pc' = [pc EXCEPT ![a] = LabelStep("label")]
    /\ UNCHANGED <<labelVars, fence, lapsedAt, lastIssued, rec, runtimeVars, tok, seenRt, wantDelete, admitted, opc,
                   nextTok, attests, crashes, askedSince, issuedL, sentOk, bad>>

\* lapseIssuedDeletion: the call ended with an outcome nobody knows, or the runtime accepted
\* the removal and has not finished it (`isRemovalPending`).
Unknown(a) ==
    LET t == tok[a] IN
    /\ pc[a] = "await"
    /\ rt[t] \in {"pending", "acted"}
    /\ dlive' = IF dstate = "issued" /\ dtok = t THEN FALSE ELSE dlive
    /\ pc' = [pc EXCEPT ![a] = LabelStep("failed")]
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, reqs, lastIssued, rec, runtimeVars,
                   tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok, attests, crashes, ghostVars>>

\* releaseDeletion: the runtime answered and did not act.
Refused(a) ==
    /\ pc[a] = "await"
    /\ rt[tok[a]] = "refused"
    /\ Release(tok[a])
    /\ pc' = [pc EXCEPT ![a] = LabelStep("failed")]
    /\ UNCHANGED <<labelVars, fence, lapsedAt, rec, runtimeVars, tok, seenCur, seenRt, wantDelete, admitted,
                   opc, nextTok, attests, crashes, ghostVars>>

\* A deleter's process dies holding a removal (authorized, issued, or with its call out).
CrashDeleter(a) ==
    /\ pc[a] \in {"issue", "send", "await"}
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ UNCHANGED <<labelVars, ledgerVars, runtimeVars, tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok,
                   attests, ghostVars>>

-----------------------------------------------------------------------------
(* Recovery (`recover-retained-executors.ts`): claimRecovery, admitRecovery,  *)
(* then the attempt drains and removes what it recovered under its claim.      *)

Claim(a) ==
    /\ pc[a] = "claim"
    /\ rec \in {"none", "lapsed"}
    /\ rec' = "live"
    /\ pc' = [pc EXCEPT ![a] = "look"]   \* first decided on what is on record
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued,
                   runtimeVars, tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok, attests,
                   crashes, ghostVars>>

\* admitRecovery: may the attempt start the executor?
Admit(a) ==
    /\ pc[a] = "admit"
    /\ CASE dstate = "deleted" ->
              \* `deleted`: removed by another path; its retention ends, recorded `stopped`.
              /\ pc' = [pc EXCEPT ![a] = LabelStep("label")]
              /\ UNCHANGED <<dstate, dtok, dcur, dlive, reqs, lastIssued, seenCur, basisCur,
                             askedSince, admitted>>
         [] dstate = "issued" \/ (dstate = "deleting" /\ dlive) ->
              /\ pc' = [pc EXCEPT ![a] = "done"]      \* `deleting`
              /\ UNCHANGED <<dstate, dtok, dcur, dlive, reqs, lastIssued, seenCur, basisCur,
                             askedSince, admitted>>
         [] rec # "live" ->
              /\ pc' = [pc EXCEPT ![a] = "done"]      \* `unclaimed`
              /\ UNCHANGED <<dstate, dtok, dcur, dlive, reqs, lastIssued, seenCur, basisCur,
                             askedSince, admitted>>
         [] dstate = "deleting" ->
              \* `admitted`; a removal whose hold lapsed before it issued anything is voided.
              /\ BumpVoiding(TRUE)
              /\ Ask
              /\ admitted' = TRUE
              /\ pc' = [pc EXCEPT ![a] = "look"]
         [] OTHER ->
              /\ Ask
              /\ admitted' = TRUE
              /\ pc' = [pc EXCEPT ![a] = "look"]
              /\ UNCHANGED <<dstate, dtok, dcur, dlive, reqs, lastIssued, seenCur, basisCur>>
    /\ UNCHANGED <<labelVars, fence, lapsedAt, rec, runtimeVars, tok, seenRt, wantDelete, opc,
                   nextTok, attests, crashes, issuedL, sentOk, everDeleted, bad>>

\* releaseRecovery when the attempt ends (fenced on its token).
EndRecovery(a) ==
    /\ a \in RecoveryActors /\ pc[a] = "done"
    /\ rec' = IF rec = "live" THEN "none" ELSE rec
    /\ pc' = [pc EXCEPT ![a] = "end"]
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued,
                   runtimeVars, tok, seenCur, seenRt, wantDelete, admitted, opc, nextTok, attests,
                   crashes, ghostVars>>

ClaimLapses ==
    /\ rec = "live" /\ rec' = "lapsed"
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued,
                   runtimeVars, actorVars, opc, nextTok, attests, crashes, ghostVars>>

-----------------------------------------------------------------------------
(* Observers: `observedAnswer` (capture-drain.ts) and the API's                 *)
(* `apiObservationRecorder`: open the fence BEFORE the request is sent, record   *)
(* the answer, close it when nothing came, end it when the answer could not be   *)
(* recorded.                                                                     *)

\* What an observer does once its question is over: a drain records its outcome (`save`).
AfterAsk(o) == IF o \in Drains /\ TrackLabel THEN "save" ELSE "done"

\* openObservation. A drain asks only under the drain claim.
Open(o) ==
    /\ opc[o] = IF o \in Drains /\ TrackLabel THEN "claimed" ELSE "idle"
    /\ IF \/ dstate = "deleted" /\ OpenRefusedWhenDeleted
          \/ dstate = "issued" /\ OpenRefusedWhileIssued
          \/ dstate = "deleting" /\ dlive
         THEN /\ opc' = [opc EXCEPT ![o] = AfterAsk(o)]  \* refused: nothing is asked
              /\ UNCHANGED <<fence, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued,
                             seenCur, basisCur, askedSince, bad>>
         ELSE /\ fence' = [fence EXCEPT ![o] = "open"]
              /\ lapsedAt' = [lapsedAt EXCEPT ![o] = {p \in Observers : fence[p] = "lapsed"}]
              \* The version bumped; a removal whose hold lapsed is voided.
              /\ BumpVoiding(dstate = "deleting")
              /\ Ask
              /\ bad' = IF dstate = "deleted" THEN bad \cup {"asked-deleted"} ELSE bad
              /\ opc' = [opc EXCEPT ![o] = "asked"]
    /\ UNCHANGED <<labelVars, rec, runtimeVars, pc, tok, seenRt, wantDelete, admitted, nextTok, attests, crashes,
                   issuedL, sentOk, everDeleted>>

\* recordStatus with its fence: resolves it and every fence that lapsed before it was opened;
\* voids a removal not yet issued. A fence already resolved by a later answer resolves nothing.
Record(o) ==
    /\ opc[o] = "asked"
    /\ fence' = IF fence[o] = "none" THEN fence
                ELSE [p \in Observers |->
                        IF p = o \/ p \in lapsedAt[o] THEN "none" ELSE fence[p]]
    /\ BumpVoiding(dstate = "deleting")
    /\ opc' = [opc EXCEPT ![o] = AfterAsk(o)]
    /\ UNCHANGED <<labelVars, lapsedAt, rec, runtimeVars, pc, tok, seenRt, wantDelete, admitted, nextTok, attests,
                   crashes, askedSince, issuedL, sentOk, everDeleted, bad>>

\* closeObservation: nothing was received. The version bumped.
Close(o) ==
    /\ opc[o] = "asked"
    /\ fence' = [fence EXCEPT ![o] = "none"]
    /\ BumpVoiding(FALSE)
    /\ opc' = [opc EXCEPT ![o] = AfterAsk(o)]
    /\ UNCHANGED <<labelVars, lapsedAt, rec, runtimeVars, pc, tok, seenRt, wantDelete, admitted, nextTok, attests,
                   crashes, askedSince, issuedL, sentOk, everDeleted, bad>>

\* endObservation: an answer came and could not be recorded; its fence lapses now.
End(o) ==
    /\ opc[o] = "asked"
    /\ IF fence[o] = "none"
         THEN UNCHANGED <<fence, dstate, dtok, dcur, dlive, reqs, lastIssued, seenCur, basisCur>>
         ELSE /\ fence' = [fence EXCEPT ![o] = "lapsed"]
              /\ BumpVoiding(FALSE)
    /\ opc' = [opc EXCEPT ![o] = AfterAsk(o)]
    /\ UNCHANGED <<labelVars, lapsedAt, rec, runtimeVars, pc, tok, seenRt, wantDelete, admitted, nextTok, attests,
                   crashes, askedSince, issuedL, sentOk, everDeleted, bad>>

\* The observer's process dies: its fence stays until it lapses and a later answer resolves it.
CrashObserver(o) ==
    /\ opc[o] = "asked" /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ opc' = [opc EXCEPT ![o] = "done"]
    /\ UNCHANGED <<labelVars, ledgerVars, runtimeVars, actorVars, nextTok, attests, ghostVars>>

\* The fence's TTL passes (`ttlMs`, the round trip's bound plus a margin).
FenceLapses(o) ==
    /\ fence[o] = "open" /\ fence' = [fence EXCEPT ![o] = "lapsed"]
    /\ UNCHANGED <<labelVars, lapsedAt, dstate, dtok, dcur, dlive, reqs, lastIssued, rec, runtimeVars,
                   actorVars, opc, nextTok, attests, crashes, ghostVars>>

-----------------------------------------------------------------------------
(* Evidence that moves without asking the executor, and time.                   *)

\* attestCompletion (the API): bumps the version, voids nothing.
Attest ==
    /\ attests < MaxAttests
    /\ attests' = attests + 1
    /\ BumpVoiding(FALSE)
    /\ UNCHANGED <<labelVars, fence, lapsedAt, rec, runtimeVars, pc, tok, seenRt, wantDelete, admitted, opc, nextTok,
                   crashes, askedSince, issuedL, sentOk, everDeleted, bad>>

\* A removal's hold expires (DELETION_HOLD_MS without a renewal).
HoldLapses ==
    /\ dstate \in {"deleting", "issued"} /\ dlive
    /\ dlive' = FALSE
    /\ UNCHANGED <<labelVars, fence, lapsedAt, dstate, dtok, dcur, reqs, lastIssued, rec, runtimeVars,
                   actorVars, opc, nextTok, attests, crashes, ghostVars>>

-----------------------------------------------------------------------------
(* The runtime: an adversary bounded by its adapter's promise that a removal   *)
(* request acts within `removalFenceMs` of being sent, or never.               *)

RuntimeActs(t) ==
    /\ rt[t] = "pending" /\ (~elapsed[t] \/ late[t])
    /\ rt' = [rt EXCEPT ![t] = "acted"]
    /\ exec' = "gone"
    /\ bad' = IF exec = "present"
                THEN bad \cup (IF askedSince[t] THEN {"stale-act"} ELSE {})
                         \cup (IF dstate # "issued" THEN {"untracked-act"} ELSE {})
                ELSE bad
    /\ UNCHANGED <<labelVars, ledgerVars, elapsed, late, actorVars, opc, nextTok, attests, crashes, askedSince,
                   basisCur, issuedL, sentOk, everDeleted>>

RuntimeRefuses(t) ==
    /\ rt[t] = "pending"
    /\ rt' = [rt EXCEPT ![t] = "refused"]
    /\ UNCHANGED <<labelVars, ledgerVars, exec, elapsed, late, actorVars, opc, nextTok, attests, crashes,
                   ghostVars>>

\* The runtime's bound on request `t` passes. Measured from when it was recorded issued; the
\* issuer sends it at once (unless SendMayOutliveBound).
BoundPasses(t) ==
    /\ issuedL[t] /\ ~elapsed[t]
    /\ \/ rt[t] # "none"
       \/ SendMayOutliveBound
       \/ ~\E a \in Actors : pc[a] = "send" /\ tok[a] = t
    /\ elapsed' = [elapsed EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<labelVars, ledgerVars, exec, rt, late, actorVars, opc, nextTok, attests, crashes, ghostVars>>

-----------------------------------------------------------------------------
(* The drain label (`workspace_capture_drains.state`) and the drain claim.     *)
(* recordObservation (`ledger.observe`) ranks a terminal label: gone, then      *)
(* stopped (`drainLabelsOutranking`). A drain's `save` (recordProgress, fenced  *)
(* on its claim) keeps a terminal label (`drainLabelsKeptOverProgress`,         *)
(* SLNT-978). markRetained (`kept`) and the stop job's `stop-failed` (through   *)
(* observe, but not terminal, so not ranked) write whatever was there.         *)

Terminal(l) == l \in {"gone", "stopped"}
Rank(l) == CASE l = "gone" -> 1 [] l = "stopped" -> 2 [] OTHER -> 0

\* recordObservation with a terminal label.
Ranked(l) == IF LabelRanked /\ Rank(label) > Rank(l) THEN label ELSE l
\* A write that does not rank. UnrankedKeepsTerminal: the proposed fix, it keeps a terminal label.
Unranked(l) == IF UnrankedKeepsTerminal /\ Terminal(label) THEN label ELSE l
\* A drain's `save`: SaveKeepsTerminal, it keeps a terminal label (`drainLabelsKeptOverProgress`).
Saved(l) == IF SaveKeepsTerminal /\ Terminal(label) THEN label ELSE l

\* Every label write, recording whether it weakened a terminal label.
WriteLabel(new) ==
    /\ label' = IF TrackLabel THEN new ELSE label
    /\ bad' = IF TrackLabel /\ Terminal(label) /\ Rank(new) < Rank(label)
                THEN bad \cup {"label-weakened"} ELSE bad

labelOther == <<ledgerVars, runtimeVars, tok, seenCur, seenRt, wantDelete, admitted, nextTok,
                attests, crashes, askedSince, basisCur, issuedL, sentOk, everDeleted>>

\* The stop job claims the run's drain before it looks at the executor
\* (process-workspace-stop.ts); held elsewhere: `busy`, it leaves the run.
StopClaims(a) ==
    /\ pc[a] = "sclaim"
    /\ IF claimBy = "none" \/ ~TrackLabel
         THEN claimBy' = (IF TrackLabel THEN a ELSE claimBy) /\ pc' = [pc EXCEPT ![a] = "look"]
         ELSE UNCHANGED claimBy /\ pc' = [pc EXCEPT ![a] = "end"]
    /\ UNCHANGED <<labelOther, opc, label, bad>>

\* It releases the claim when it ends (fenced on its token).
StopReleases(a) ==
    /\ TrackLabel /\ a \in StopJobs /\ pc[a] = "done"
    /\ claimBy' = IF claimBy = a THEN "none" ELSE claimBy
    /\ pc' = [pc EXCEPT ![a] = "end"]
    /\ UNCHANGED <<labelOther, opc, label, bad>>

\* markRetained: the deleter decided to keep the executor (reconcile-runtime-exits.ts,
\* process-workspace-stop.ts, the reaper).
MarkRetained(a) ==
    /\ pc[a] = "retain"
    /\ WriteLabel(Unranked("kept"))
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ UNCHANGED <<labelOther, opc, claimBy>>

\* The runtime call failed: the stop job records `stop-failed`; any other deleter writes nothing.
StopFailed(a) ==
    /\ pc[a] = "failed"
    /\ IF a \in StopJobs THEN WriteLabel(Unranked("stop-failed")) ELSE UNCHANGED <<label, bad>>
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ UNCHANGED <<labelOther, opc, claimBy>>

\* The removal is recorded on the drain: `stopped` (`removalObservation`, on recorded evidence).
LabelStopped(a) ==
    /\ pc[a] = "label"
    /\ WriteLabel(Ranked("stopped"))
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ UNCHANGED <<labelOther, opc, claimBy>>

\* The runtime has nothing of the executor (basis `missing`): `gone`, or `stopped` when the
\* evidence on record says its work was saved (`terminalCaptureState`).
LabelMissing(a) ==
    /\ pc[a] = "missing"
    /\ \E l \in {"gone", "stopped"} : WriteLabel(Ranked(l))
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ UNCHANGED <<labelOther, opc, claimBy>>

\* A drain claims the run (`drainCaptureBeforeStop`); held elsewhere: `busy`.
DrainClaims(o) ==
    /\ o \in Drains /\ TrackLabel /\ opc[o] = "idle"
    /\ IF claimBy = "none" \/ ~TrackLabel
         THEN claimBy' = (IF TrackLabel THEN o ELSE claimBy) /\ opc' = [opc EXCEPT ![o] = "claimed"]
         ELSE UNCHANGED claimBy /\ opc' = [opc EXCEPT ![o] = "done"]
    /\ UNCHANGED <<labelOther, pc, label, bad>>

\* `persist`: recordProgress with the drain's outcome, written only while its claim holds (`gone`
\* only when the runtime has nothing of the executor), and never over a terminal label; then the
\* claim is released.
DrainSaves(o) ==
    /\ opc[o] = "save"
    /\ IF claimBy = o /\ TrackLabel
         \* `draining` stands for every outcome a drain records that is not terminal (`saved`,
         \* `kept`): they rank the same, below every terminal label.
         THEN \E l \in {"draining"} \cup (IF exec = "gone" THEN {"gone"} ELSE {}) :
                WriteLabel(Saved(l))
         ELSE UNCHANGED <<label, bad>>
    /\ claimBy' = IF claimBy = o THEN "none" ELSE claimBy
    /\ opc' = [opc EXCEPT ![o] = "done"]
    /\ UNCHANGED <<labelOther, pc>>

\* A drain claim's lease lapses (its holder stalled or died).
DrainClaimLapses ==
    /\ TrackLabel /\ claimBy # "none" /\ claimBy' = "none"
    /\ UNCHANGED <<labelOther, pc, opc, label, bad>>

-----------------------------------------------------------------------------

OldNext ==
    \/ \E a \in Actors :
          \/ Look(a) \/ Read(a) \/ Authorize(a) \/ Settle(a) \/ Issue(a) \/ Send(a)
          \/ NotSent(a) \/ Renew(a) \/ Succeed(a) \/ Unknown(a) \/ Refused(a)
          \/ CrashDeleter(a) \/ Claim(a) \/ Admit(a) \/ EndRecovery(a)
    \/ \E o \in Observers :
          Open(o) \/ Record(o) \/ Close(o) \/ End(o) \/ CrashObserver(o) \/ FenceLapses(o)
    \/ \E t \in Tokens : RuntimeActs(t) \/ RuntimeRefuses(t) \/ BoundPasses(t)
    \/ Attest \/ HoldLapses \/ ClaimLapses

Next ==
    \/ OldNext
    \/ \E a \in Actors :
          \/ StopClaims(a) \/ StopReleases(a) \/ MarkRetained(a) \/ StopFailed(a)
          \/ LabelStopped(a) \/ LabelMissing(a)
    \/ \E o \in Observers : DrainClaims(o) \/ DrainSaves(o)
    \/ DrainClaimLapses

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The promises.                                                             *)

\* 1. Every removal request is sent on the evidence its decision was made on, still current,
\*    with no observation in flight: the first, every reissue, and a re-based reissue alike.
SentOnCurrentEvidence == \A t \in Tokens : sentOk[t]

\* 2. Nothing is asked of the executor (no observation opened, no recovery admitted) between a
\*    request being sent and the runtime removing the executor on it.
NothingAskedBeforeRemoval == "stale-act" \notin bad

\* 3. The runtime removes the executor only while the ledger holds that removal issued: an
\*    issued removal is never given up while a request of it may still act.
RemovalStaysIssued == "untracked-act" \notin bad

\* 4. Deleted means gone, and stays deleted: nothing is authorized over it.
DeletedMeansGone == dstate = "deleted" => exec = "gone"
DeletedIsFinal == everDeleted => dstate = "deleted"

\* 5. Nothing is asked of a removed executor.
NothingAskedOfDeleted == "asked-deleted" \notin bad

\* 6. While a recovery claim is live, only that recovery is authorized to remove the executor.
RecoveryExclusive == "over-recovery" \notin bad

\* 7. Once the drain label is terminal (`gone`, `stopped`), no write weakens it: not to a weaker
\*    terminal label, not to a non-terminal one (`kept`, `stop-failed`, `draining`, `saved`).
LabelNeverWeakened == "label-weakened" \notin bad

\* 8. A terminal label means the runtime no longer has the executor.
TerminalLabelMeansRemoved == Terminal(label) => exec = "gone"

=============================================================================
