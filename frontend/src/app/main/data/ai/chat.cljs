;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.chat
  "Penforge AI chat state and events.

  State lives under `[:penforge :chat]`:

  - `:conversation-id` active conversation of the open file
  - `:status` `:idle` or `:streaming` (a turn is running)
  - `:entries` the timeline; each entry has `:kind`:
    `:user` `:assistant` `:tool` `:error` `:permission` `:question`
    `:workflow`, and an `:id`
  - `:attachments` pending attachments of the next message (nodes, and
    files with a local `:id`)
  - `:runs` workflow runs started from this tab, by run id
  - `:pending-runs` `workflow.run` requests waiting for `workflow.started`,
    by rid
  - `:activity` the AI's current or last work as the chat shows it
    (`:started-at`, `:ended-at`, `:outcome` `:done|:error|:cancelled`,
    `:cancelled`, `:failed`, `:from` index of its first entry), kept by
    `track-activity`
  - `:dismissed-selection` ids of the canvas selection the user removed
    from the next message's context (W25)
  - `:outbox` attachments of sent messages until they go out, by message
    id (file bytes are kept out of the timeline)

  `apply-message` is the pure reducer of daemon messages; every event
  of this namespace goes through it or through small pure helpers."
  (:require
   ["rxjs" :as rxjs]
   [app.common.data :as d]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.common :as dcm]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.layout :as dwl]
   [app.util.storage :as storage]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def empty-chat
  {:conversation-id nil
   :status :idle
   :entries []
   :attachments []
   :runs {}
   :pending-runs {}
   :history-status :none})

;; --- Pure helpers

(defn- now-str
  []
  (ct/format-inst (ct/now)))

(defn- find-entry-index
  "Index of the last entry matching `pred`, or nil."
  [entries pred]
  (loop [index (dec (count entries))]
    (when (>= index 0)
      (if (pred (nth entries index))
        index
        (recur (dec index))))))

(defn- update-entry
  [chat pred f & args]
  (if-let [index (find-entry-index (:entries chat) pred)]
    (apply update-in chat [:entries index] f args)
    chat))

(defn- append-entry
  [chat entry]
  (update chat :entries conj entry))

(defn- active-conversation?
  [chat msg]
  (= (:conversation-id chat) (:conversation-id msg)))

(defn attachment-key
  "Key of an attachment in a list: node id, local file id, thread id or
  stored file path."
  [attachment]
  (or (:node-id attachment)
      (:id attachment)
      (:thread-id attachment)
      (:path attachment)
      (:name attachment)))

(defn- node-attachment?
  [attachment]
  (= "node" (:kind attachment)))

(defn- entry-attachment
  "An attachment as the timeline keeps it: files without their bytes."
  [attachment]
  (if (= "file" (:kind attachment))
    (dissoc attachment :base64)
    attachment))

(defn- wire-attachment
  "An attachment as the daemon receives it: no client-only keys."
  [attachment]
  (if (= "file" (:kind attachment))
    (dissoc attachment :id)
    attachment))

(defn- history->entry
  [{:keys [role message-id text ts attachments]}]
  (if (= role "user")
    {:kind :user :id message-id :text text :ts ts :attachments (vec attachments)}
    {:kind :assistant :id message-id :text text :ts ts}))

(defn- apply-chat-delta
  [chat {:keys [message-id text] :as msg}]
  (if (active-conversation? chat msg)
    (let [index (find-entry-index (:entries chat)
                                  #(and (= :assistant (:kind %))
                                        (= message-id (:id %))))]
      (-> (if index
            (update-in chat [:entries index :text] str text)
            (append-entry chat {:kind :assistant
                                :id message-id
                                :text text
                                :streaming true}))
          (assoc :status :streaming)))
    chat))

(defn- apply-chat-tool
  [chat {:keys [tool-name summary status detail] :as msg}]
  (if (active-conversation? chat msg)
    (let [status (keyword status)
          index  (find-entry-index (:entries chat)
                                   #(and (= :tool (:kind %))
                                         (= tool-name (:tool-name %))
                                         (= :running (:status %))))]
      (if (and index (not= :running status))
        (update-in chat [:entries index] assoc
                   :status status
                   :summary summary
                   :detail (or detail (get-in chat [:entries index :detail])))
        (append-entry chat (d/without-nils
                            {:kind :tool
                             :id (str (uuid/next))
                             :tool-name tool-name
                             :summary summary
                             :status status
                             :detail detail}))))
    chat))

(defn- apply-chat-done
  [chat {:keys [message-id usage] :as msg}]
  (if (active-conversation? chat msg)
    (-> chat
        (update-entry #(and (= :assistant (:kind %)) (= message-id (:id %)))
                      (fn [entry]
                        (-> entry
                            (dissoc :streaming)
                            (cond-> (some? usage) (assoc :usage usage)))))
        (update :entries (fn [entries]
                           (mapv (fn [entry]
                                   (if (and (= :tool (:kind entry))
                                            (= :running (:status entry)))
                                     (assoc entry :status :done)
                                     entry))
                                 entries)))
        (assoc :status :idle))
    chat))

(defn- apply-chat-history
  [chat {:keys [messages] :as msg}]
  (if (active-conversation? chat msg)
    (-> chat
        ;; Keep entries added while the history was on its way.
        (update :entries #(into (mapv history->entry messages) %))
        (assoc :history-status :loaded))
    chat))

(defn- apply-workflow-started
  [chat {:keys [rid run-id name]}]
  (if (contains? (:pending-runs chat) rid)
    (let [{:keys [silent]} (get-in chat [:pending-runs rid])]
      (-> chat
          (update :pending-runs dissoc rid)
          (assoc-in [:runs run-id] {:run-id run-id
                                    :rid rid
                                    :name name
                                    :status :running
                                    :silent silent})
          (cond-> (not silent)
            (append-entry {:kind :workflow
                           :id run-id
                           :name name
                           :status :running}))))
    chat))

(defn- apply-workflow-event
  [chat {:keys [run-id kind payload]}]
  (if (contains? (:runs chat) run-id)
    (case kind
      "question"
      (append-entry chat {:kind :question
                          :id (:question-id payload)
                          :run-id run-id
                          :text (:text payload)
                          :options (vec (:options payload))})

      "progress"
      (-> chat
          (assoc-in [:runs run-id :progress] payload)
          (update-entry #(and (= :workflow (:kind %)) (= run-id (:id %)))
                        assoc :progress payload))

      (update-in chat [:runs run-id :events] (fnil conj []) {:kind kind :payload payload}))
    chat))

(defn- apply-workflow-done
  [chat {:keys [run-id ok summary error]}]
  (if (contains? (:runs chat) run-id)
    (let [status (if ok :done :error)]
      (-> chat
          (update-in [:runs run-id] assoc :status status :summary summary :error error)
          (update-entry #(and (= :workflow (:kind %)) (= run-id (:id %)))
                        (fn [entry]
                          (d/without-nils
                           (assoc entry :status status :summary summary :error error))))))
    chat))

(defn- apply-error
  [chat {:keys [rid code message]}]
  (cond
    ;; A failed history request only means there is nothing to restore.
    (and (some? rid) (= rid (:history-rid chat)))
    (assoc chat :history-status :error)

    (contains? (:pending-runs chat) rid)
    (let [{:keys [silent]} (get-in chat [:pending-runs rid])]
      (-> chat
          (update :pending-runs dissoc rid)
          (cond-> (not silent)
            (append-entry {:kind :error :id (str (uuid/next)) :code code :message message}))))

    :else
    (append-entry chat {:kind :error :id (str (uuid/next)) :code code :message message})))

(defn apply-message
  "Reduce a daemon message into the chat state."
  [chat msg]
  (case (:type msg)
    "chat.delta"         (apply-chat-delta chat msg)
    "chat.tool"          (apply-chat-tool chat msg)
    "chat.done"          (apply-chat-done chat msg)
    "chat.history"       (apply-chat-history chat msg)
    "permission.request" (append-entry chat {:kind :permission
                                             :id (:request-id msg)
                                             :title (:title msg)
                                             :description (:description msg)
                                             :risk (keyword (:risk msg))})
    "workflow.started"   (apply-workflow-started chat msg)
    "workflow.event"     (apply-workflow-event chat msg)
    "workflow.done"      (apply-workflow-done chat msg)
    "error"              (apply-error chat msg)
    chat))

(defn add-user-message
  "Append the user message with the pending attachments, plus the
  `context` attachments (the canvas selection), and start a turn. The
  attachments to send wait in `:outbox` under the message id; the
  timeline keeps them without file bytes."
  ([chat id text]
   (add-user-message chat id text nil))
  ([chat id text context]
   (let [attachments (into (vec (:attachments chat)) context)]
     (-> chat
         (append-entry (d/without-nils
                        {:kind :user
                         :id id
                         :text text
                         :ts (now-str)
                         :attachments (not-empty (mapv entry-attachment attachments))}))
         (cond-> (seq attachments)
           (assoc-in [:outbox id] (mapv wire-attachment attachments)))
         (assoc :attachments [])
         (assoc :status :streaming)))))

(defn add-attachments
  "Add attachments to the pending list, skipping nodes already there."
  [chat attachments]
  (update chat :attachments
          (fn [current]
            (first
             (reduce (fn [[result ids :as acc] attachment]
                       (let [node-id (when (node-attachment? attachment)
                                       (:node-id attachment))]
                         (if (and (some? node-id) (contains? ids node-id))
                           acc
                           [(conj result attachment) (cond-> ids node-id (conj node-id))])))
                     [(vec current) (into #{} (comp (filter node-attachment?) (map :node-id)) current)]
                     attachments)))))

;; --- Working state (W25)

(defn working?
  "True while the AI works for this chat: a turn streams, or a workflow
  run shown in the timeline is starting or running."
  [chat]
  (boolean
   (or (= :streaming (:status chat))
       (some (fn [[_ run]] (not (:silent run))) (:pending-runs chat))
       (some (fn [[_ run]] (and (= :running (:status run)) (not (:silent run))))
             (:runs chat)))))

(defn busy?
  "True while the AI may change the design: like `working?`, but silent
  runs (started by dialogs and panels) count too."
  [chat]
  (boolean
   (or (= :streaming (:status chat))
       (seq (:pending-runs chat))
       (some (fn [[_ run]] (= :running (:status run))) (:runs chat)))))

(defn waiting?
  "True while the AI waits for the user: a permission request or a
  question is open."
  [chat]
  (and (busy? chat)
       (boolean
        (some #(and (contains? #{:permission :question} (:kind %))
                    (nil? (:answer %)))
              (:entries chat)))))

(defn- progress-text
  [progress]
  (or (when (string? progress) progress)
      (when (string? (:text progress)) (:text progress))))

(defn current-step
  "What the AI is doing now, from the newest entries: `{:type :waiting}`,
  `{:type :tool :text summary}`, `{:type :workflow :text progress}`,
  `{:type :writing}` or `{:type :thinking}`."
  [chat]
  (or (when (waiting? chat)
        {:type :waiting})
      (loop [index (dec (count (:entries chat)))]
        (when (>= index 0)
          (let [{:keys [kind status summary progress streaming]} (nth (:entries chat) index)]
            (cond
              (and (= :tool kind) (= :running status))
              {:type :tool :text summary}

              (and (= :workflow kind) (= :running status))
              {:type :workflow :text (progress-text progress)}

              (and (= :assistant kind) streaming)
              {:type :writing}

              (= :user kind)
              nil

              :else
              (recur (dec index))))))
      (some (fn [[_ run]]
              (when (and (= :running (:status run)) (not (:silent run)))
                {:type :workflow :text (progress-text (:progress run))}))
            (:runs chat))
      {:type :thinking}))

(defn- failure?
  "True when `after` adds an error to the timeline or ends a shown run with
  an error."
  [before after]
  (let [entry (peek (:entries after))]
    (boolean
     (or (and (= :error (:kind entry))
              (not= entry (peek (:entries before))))
         (some (fn [[run-id run]]
                 (and (= :error (:status run))
                      (not (:silent run))
                      (not= :error (get-in before [:runs run-id :status]))))
               (:runs after))))))

(defn track-activity
  "Keep `:activity` in step after the chat changed from `before` to `after`
  at `now` (ms): starts it when the AI starts working, notes failures
  while it works, and records the end time and outcome when it stops."
  [before after now]
  (let [was (working? before)
        is  (working? after)]
    (cond
      (and is (not was))
      (assoc after :activity {:started-at now :from (count (:entries before))})

      (not (or is was))
      after

      :else
      (let [after (cond-> after
                    (failure? before after)
                    (assoc-in [:activity :failed] true))]
        (if (and was (not is))
          (let [{:keys [cancelled failed]} (:activity after)]
            (update after :activity assoc
                    :ended-at now
                    :outcome (cond cancelled :cancelled
                                   failed :error
                                   :else :done)))
          after)))))

(defn failed-steps
  "Number of steps (tool calls, canvas checks) that failed during the
  current or last activity."
  [chat]
  (let [entries (:entries chat)
        from    (min (count entries) (get-in chat [:activity :from] 0))]
    (count (filter #(and (= :tool (:kind %)) (= :error (:status %)))
                   (subvec entries from)))))

(defn- update-chat
  "Update the chat state with `f` and track the AI's activity."
  [state f & args]
  (let [before (get-in state [:penforge :chat] empty-chat)
        after  (apply f before args)]
    (assoc-in state [:penforge :chat] (track-activity before after (js/Date.now)))))

;; --- Selection as context (W25)

(def max-selection-attachments
  "Most selected shapes the chat attaches by itself to one message."
  10)

(defn selection-context
  "Node attachments the next message takes from the canvas selection
  `selected` (shape ids in selection order): at most
  `max-selection-attachments`, none when a node is attached by hand or
  the user removed this selection from the message."
  [chat selected objects file-id page-id]
  (when (and (seq selected)
             (not (some node-attachment? (:attachments chat)))
             (not= (set selected) (:dismissed-selection chat)))
    (not-empty
     (into []
           (comp (keep #(get objects %))
                 (take max-selection-attachments)
                 (map #(proto/node-attachment file-id page-id %)))
           selected))))

(defn- state-selection-context
  [state]
  (selection-context (get-in state [:penforge :chat] empty-chat)
                     (dsh/get-selected-ids state)
                     (dsh/lookup-page-objects state)
                     (:current-file-id state)
                     (:current-page-id state)))

(defn end-turn
  "Close a running turn whose `chat.done` will never come (lost
  connection)."
  [chat]
  (-> chat
      (assoc :status :idle)
      (assoc :outbox {})
      (update :entries (fn [entries]
                         (mapv (fn [entry]
                                 (cond
                                   (:streaming entry) (dissoc entry :streaming)
                                   (= :running (:status entry)) (assoc entry :status :error)
                                   :else entry))
                               entries)))))

(defn answer-entry
  "Record the answer of a permission or question entry."
  [chat id answer]
  (update-entry chat
                #(and (contains? #{:permission :question} (:kind %)) (= id (:id %)))
                assoc :answer answer))

;; --- Conversation ids (kept per file in local storage; not secret)

(defn- get-stored-conversation-id
  [file-id]
  (get-in storage/user [::conversations file-id]))

(defn- store-conversation-id
  [file-id conversation-id]
  (swap! storage/user assoc-in [::conversations file-id] conversation-id))

;; --- Events

(defn- get-chat
  [state]
  (get-in state [:penforge :chat] empty-chat))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn receive
  "Apply a daemon message to the chat state."
  [msg]
  (ptk/reify ::receive
    ptk/UpdateEvent
    (update [_ state]
      (update-chat state apply-message msg))))

(defn- request-history
  []
  (let [rid (proto/next-rid)]
    (ptk/reify ::request-history
      ptk/UpdateEvent
      (update [_ state]
        (let [{:keys [conversation-id history-status]} (get-chat state)]
          (if (and conversation-id
                   (not= :loaded history-status)
                   (connected? state))
            (update-in state [:penforge :chat] assoc
                       :history-status :loading
                       :history-rid rid)
            state)))

      ptk/WatchEvent
      (watch [_ state _]
        (let [{:keys [conversation-id history-rid]} (get-chat state)]
          (if (= rid history-rid)
            (rx/of (client/send (proto/chat-history {:rid rid
                                                     :conversation-id conversation-id})))
            (rx/empty)))))))

(defn initialize
  "Start the chat of the open file: restore its conversation and follow
  daemon messages."
  [file-id]
  (ptk/reify ::initialize
    ptk/UpdateEvent
    (update [_ state]
      (let [conversation-id (or (get-stored-conversation-id file-id)
                                (str (uuid/next)))]
        (assoc-in state [:penforge :chat]
                  (assoc empty-chat
                         :file-id file-id
                         :conversation-id conversation-id))))

    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper-s (rx/merge
                       (rx/filter (ptk/type? ::finalize) stream)
                       (rx/filter (ptk/type? ::initialize) stream))]
        (->> (rx/merge
              (->> (client/messages stream)
                   (rx/map receive))

              ;; Restore the stored messages once connected.
              (->> stream
                   (rx/filter (ptk/type? ::client/connected))
                   (rx/map (fn [_] (request-history))))

              (->> stream
                   (rx/filter (ptk/type? ::client/socket-closed))
                   (rx/map (fn [_] (ptk/reify ::connection-lost
                                     ptk/UpdateEvent
                                     (update [_ state]
                                       (update-chat state end-turn))))))

              (rx/of (request-history)))
             (rx/take-until stopper-s))))

    ptk/EffectEvent
    (effect [_ state _]
      (store-conversation-id file-id (get-in state [:penforge :chat :conversation-id])))))

(defn finalize
  []
  (ptk/reify ::finalize
    ptk/UpdateEvent
    (update [_ state]
      (update state :penforge dissoc :chat))))

(defn new-conversation
  "Start a new, empty conversation for the open file."
  []
  (ptk/reify ::new-conversation
    ptk/UpdateEvent
    (update [_ state]
      (let [chat (get-chat state)]
        (assoc-in state [:penforge :chat]
                  (assoc empty-chat
                         :file-id (:file-id chat)
                         :conversation-id (str (uuid/next))
                         :attachments (:attachments chat)
                         :history-status :loaded))))

    ptk/EffectEvent
    (effect [_ state _]
      (let [{:keys [file-id conversation-id]} (get-chat state)]
        (when file-id
          (store-conversation-id file-id conversation-id))))))

(defn- clear-outbox
  [id]
  (ptk/reify ::clear-outbox
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat :outbox] dissoc id))))

(defn send-message
  "Send a chat message with the pending attachments and, when no node is
  attached by hand, the canvas selection (W25)."
  [text]
  (let [id   (str (uuid/next))
        text (some-> text str .trim)]
    (ptk/reify ::send-message
      ptk/UpdateEvent
      (update [_ state]
        (let [chat (get-chat state)]
          (cond
            (empty? text)
            state

            (not (connected? state))
            (update-in state [:penforge :chat] append-entry
                       {:kind :error :id id :code "not-connected"})

            (= :streaming (:status chat))
            state

            :else
            (update-chat state add-user-message id text (state-selection-context state)))))

      ptk/WatchEvent
      (watch [_ state _]
        (let [{:keys [conversation-id entries outbox]} (get-chat state)
              entry (peek entries)]
          (if (and (= id (:id entry)) (= :user (:kind entry)))
            (rx/of (client/send (proto/chat-send {:rid id
                                                  :conversation-id conversation-id
                                                  :text text
                                                  :attachments (get outbox id)}))
                   (clear-outbox id))
            (rx/empty)))))))

(defn- mark-cancelled
  [chat]
  (cond-> chat
    (working? chat) (assoc-in [:activity :cancelled] true)))

(defn cancel
  "Stop the running turn."
  []
  (ptk/reify ::cancel
    ptk/UpdateEvent
    (update [_ state]
      (if (= :streaming (get-in state [:penforge :chat :status]))
        (update-in state [:penforge :chat] mark-cancelled)
        state))

    ptk/EffectEvent
    (effect [_ state _]
      (let [{:keys [conversation-id status]} (get-chat state)]
        (when (= :streaming status)
          (client/send! (proto/chat-cancel conversation-id)))))))

(defn attach-node
  "Attach shapes of the current page (by id) to the next message."
  [shape-ids]
  (ptk/reify ::attach-node
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id (:current-file-id state)
            page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state)
            shapes  (keep #(get objects %) shape-ids)]
        (update-in state [:penforge :chat]
                   (fnil add-attachments empty-chat)
                   (map #(proto/node-attachment file-id page-id %) shapes))))))

(defn remove-attachment
  "Remove a pending attachment by its `attachment-key` (node id or local
  file id)."
  [key]
  (ptk/reify ::remove-attachment
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat :attachments]
                 (fn [attachments]
                   (into [] (remove #(= key (attachment-key %))) attachments))))))

(defn add-files
  "Add file attachments (`proto/file-attachment` maps) to the next
  message; each gets a local `:id`."
  [files]
  (ptk/reify ::add-files
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat]
                 (fnil add-attachments empty-chat)
                 (map #(assoc % :id (str (uuid/next))) files)))))

(defn dismiss-selection
  "Leave the current canvas selection out of the next message."
  [selected]
  (ptk/reify ::dismiss-selection
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat] (fnil assoc empty-chat)
                 :dismissed-selection (set selected)))))

(defn respond-permission
  "Answer a permission request of the daemon."
  [request-id allow & {:keys [remember]}]
  (ptk/reify ::respond-permission
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat] answer-entry request-id (if allow :allowed :denied)))

    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/permission-respond {:request-id request-id
                                               :allow allow
                                               :remember remember})))))

(defn answer-question
  "Answer a workflow question with one of its options."
  [run-id question-id option-id]
  (ptk/reify ::answer-question
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat] answer-entry question-id option-id))

    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/workflow-answer {:run-id run-id
                                            :question-id question-id
                                            :option-id option-id})))))

(defn run-workflow
  "Start a daemon workflow (architecture §7). Options:
  - `:rid` request id, to follow the run with `workflow-messages`
  - `:silent` true keeps the run out of the chat timeline (questions
    still show).
  Features call this from their registered actions."
  ([name params]
   (run-workflow name params nil))
  ([name params {:keys [rid silent]}]
   (let [message (proto/workflow-run {:rid (or rid (proto/next-rid))
                                      :name name
                                      :params params})]
     (ptk/reify ::run-workflow
       ptk/UpdateEvent
       (update [_ state]
         (if (connected? state)
           (update-chat state assoc-in
                        [:pending-runs (:rid message)]
                        {:name name :silent (boolean silent)})
           (update-in state [:penforge :chat] (fnil append-entry empty-chat)
                      {:kind :error :id (str (uuid/next)) :code "not-connected"})))

       ptk/EffectEvent
       (effect [_ state _]
         (when (connected? state)
           (client/send! message)))))))

(defn workflow-messages
  "Stream of the daemon messages of the run started with `rid`:
  `workflow.started`, its `workflow.event`s and the final
  `workflow.done` (or an `error` for the request). Completes after the
  last one."
  [stream rid]
  (let [messages (client/messages stream)]
    (->> messages
         (rx/filter #(and (= rid (:rid %))
                          (contains? #{"workflow.started" "error"} (:type %))))
         (rx/take 1)
         (rx/mapcat
          (fn [{:keys [type run-id] :as started}]
            (if (= "error" type)
              (rx/of started)
              (rx/concat
               (rx/of started)
               (->> messages
                    (rx/filter #(= run-id (:run-id %)))
                    ;; inclusive: the `workflow.done` is emitted too
                    (rx/pipe (rxjs/takeWhile #(not= "workflow.done" (:type %)) true))))))))))

(defn cancel-workflow
  [run-id]
  (ptk/reify ::cancel-workflow
    ptk/UpdateEvent
    (update [_ state]
      (let [run (get-in state [:penforge :chat :runs run-id])]
        (if (and (= :running (:status run)) (not (:silent run)))
          (update-in state [:penforge :chat] mark-cancelled)
          state)))

    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/workflow-cancel run-id)))))

(defn open-chat
  "Show the AI tab of the left sidebar."
  []
  (ptk/reify ::open-chat
    ptk/WatchEvent
    (watch [_ state _]
      (rx/concat
       (if (contains? (:workspace-layout state) :collapse-left-sidebar)
         (rx/of (dwl/remove-layout-flag :collapse-left-sidebar))
         (rx/empty))
       (rx/of (dcm/go-to-workspace :layout :ai-chat))))))
