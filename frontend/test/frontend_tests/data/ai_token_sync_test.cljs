;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-token-sync-test
  "W21: the token sync action, its run handling (translated progress,
  summary and failures, preview reload) and the token watcher."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.generate :as gen]
   [app.main.data.ai.actions.token-sync :as ts]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.preview :as preview]
   [app.util.i18n :as i18n]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(defn- workspace-state
  [& {:keys [connected read-only can-edit preview-status]
      :or {can-edit true}}]
  {:permissions {:can-edit can-edit}
   :workspace-global {:read-only? (boolean read-only)}
   :penforge {:connection {:status (if connected :connected :disconnected)}
              :preview {:status (or preview-status :idle)}}})

(defn- collect
  [observable]
  (let [values (atom [])]
    (rx/sub! observable #(swap! values conj %))
    values))

(defn- with-keys
  "Call `f` with `tr` answering the key followed by its arguments."
  [f]
  (with-redefs [i18n/tr (fn ([key] key) ([key & args] (str/join " " (cons key args))))]
    (f)))

;; --- action

(t/deftest the-action-is-registered-for-editors
  (let [registry @actions/registry
        action   (get registry :ai/token-sync)]
    (t/is (some? action))
    (t/is (= #{:main-menu :command-palette} (:scopes action)))
    (doseq [scope [:main-menu :command-palette]]
      (t/is (some #(= :ai/token-sync (:id %))
                  (actions/get-actions registry scope (workspace-state)))
            (str scope)))
    (t/is (actions/enabled? action (workspace-state)))
    (t/is (not (actions/enabled? action (workspace-state :read-only true))))
    (t/is (not (actions/enabled? action (workspace-state :can-edit false))))))

;; --- texts

(t/deftest summaries-come-from-the-result-payload
  (with-keys
    (fn []
      (t/is (= "penforge.token-sync.summary.updated src/theme.ts 6"
               (ts/summary-text {:outcome "updated" :token-count 6 :theme-file "src/theme.ts"})))
      (t/is (= (str "penforge.token-sync.summary.updated src/theme.ts 6 "
                    "penforge.token-sync.summary.linked 2")
               (ts/summary-text {:outcome "updated" :token-count 6 :theme-file "src/theme.ts"
                                 :link "done" :linked-files ["a" "b"]})))
      (t/is (= "penforge.token-sync.summary.unchanged 3"
               (ts/summary-text {:outcome "unchanged" :token-count 3})))
      (t/is (= "penforge.token-sync.summary.no-app 4"
               (ts/summary-text {:outcome "no-app" :token-count 4})))
      (t/is (= "penforge.token-sync.summary.no-app-empty"
               (ts/summary-text {:outcome "no-app" :token-count 0})))
      (t/is (= "penforge.token-sync.summary.no-tokens"
               (ts/summary-text {:outcome "no-tokens"})))
      (t/is (nil? (ts/summary-text {:outcome "later"})))
      (t/is (= "penforge.token-sync.summary.no-theme" (ts/summary-text {:outcome "no-theme"})))
      (t/is (= "penforge.token-sync.summary.selection-changed"
               (ts/summary-text {:outcome "selection-changed"})))
      (t/is (= "penforge.token-sync.summary.block-edited src/theme.ts"
               (ts/summary-text {:outcome "block-edited" :theme-file "src/theme.ts"})))
      (t/is (= (str "penforge.token-sync.summary.unchanged 2 "
                    "penforge.token-sync.summary.deprecated 1 "
                    "penforge.token-sync.summary.refused 2 "
                    "penforge.token-sync.summary.uncommitted src/theme.ts")
               (ts/summary-text {:outcome "unchanged" :token-count 2 :deprecated ["a"]
                                 :refused ["b" "c"] :uncommitted ["src/theme.ts"]})))
      (t/is (= "penforge.token-sync.failed.broken-block" (ts/failed-text "broken-block")))
      (t/is (= "penforge.token-sync.failed.theme-check-failed" (ts/failed-text "theme-check-failed")))
      (t/is (nil? (ts/failed-text "other"))))))

(t/deftest quiet-syncs-leave-a-notice-only-when-they-need-attention
  (with-keys
    (fn []
      (let [state*  (volatile! {})
            events  #(ts/watch-events state* %)]
        (t/is (= [::ts/reload-preview]
                 (mapv ptk/type (events {:type "workflow.event" :kind "result"
                                         :payload {:outcome "updated" :theme-changed true}}))))
        (t/is (= [] (events {:type "workflow.done" :ok true}))))
      (let [state* (volatile! {})
            events #(ts/watch-events state* %)]
        (events {:type "workflow.event" :kind "result"
                 :payload {:outcome "block-edited" :theme-file "src/theme.ts"}})
        (let [[event] (events {:type "workflow.done" :ok true})
              state   {:penforge {:chat {:entries []}}}
              state'  (ptk/update event state)]
          (t/is (= ::ts/notice (ptk/type event)))
          (t/is (= "penforge.token-sync.summary.block-edited src/theme.ts"
                   (get-in state' [:penforge :chat :entries 0 :message])))
          (t/is (= :error (get-in state' [:penforge :chat :entries 0 :kind])))
          (t/is (= state' (ptk/update event state')) "the same notice is shown once")
          (t/is (= {} (ptk/update event {})) "no chat, no notice")))
      (let [state* (volatile! {})
            events #(ts/watch-events state* %)]
        (events {:type "workflow.event" :kind "failed" :payload {:code "theme-check-failed"}})
        (t/is (= [::ts/notice] (mapv ptk/type (events {:type "workflow.done" :ok false})))))
      (let [state* (volatile! {})
            events #(ts/watch-events state* %)]
        (events {:type "workflow.event" :kind "result" :payload {:outcome "selection-changed"}})
        (t/is (= [] (events {:type "workflow.done" :ok true})) "a theme switch stays quiet")))))

;; --- run

(t/deftest run-events-translate-steps-and-reload-the-preview
  (with-keys
    (fn []
      (let [state*  (volatile! {})
            events  #(ts/run-events state* %)
            update  (fn [event] (ptk/update event {:penforge {:chat {:runs {"r" {}}
                                                                     :entries [{:kind :workflow :id "r"}]}}}))]
        (let [[event] (events {:type "workflow.event" :run-id "r" :kind "progress"
                               :payload {:step "theme" :status "running" :text "Updating the app theme"}})]
          (t/is (= ::gen/localize-run (ptk/type event)))
          (t/is (= "penforge.token-sync.step.theme"
                   (get-in (update event) [:penforge :chat :entries 0 :progress :text]))))
        (t/is (= [] (events {:type "workflow.event" :run-id "r" :kind "progress"
                             :payload {:text "Saving a checkpoint"}})))
        (let [[event] (events {:type "workflow.event" :run-id "r" :kind "result"
                               :payload {:outcome "updated" :token-count 2 :theme-file "src/theme.css"
                                         :theme-changed true}})]
          (t/is (= ::ts/reload-preview (ptk/type event))))
        (let [[event] (events {:type "workflow.done" :run-id "r" :ok true})]
          (t/is (= "penforge.token-sync.summary.updated src/theme.css 2"
                   (get-in (update event) [:penforge :chat :entries 0 :summary]))))
        ;; an unchanged theme reloads nothing
        (t/is (= [] (events {:type "workflow.event" :run-id "r" :kind "result"
                             :payload {:outcome "unchanged" :theme-changed false}})))))))

(t/deftest a-failed-run-shows-the-translated-failure
  (with-keys
    (fn []
      (let [state* (volatile! {})
            events #(ts/run-events state* %)]
        (t/is (= [] (events {:type "workflow.event" :run-id "r" :kind "failed"
                             :payload {:code "penpot-unreachable" :message "No plugin"}})))
        (let [[event] (events {:type "workflow.done" :run-id "r" :ok false :error "No plugin"})
              chat    {:runs {"r" {}} :entries [{:kind :workflow :id "r" :error "No plugin"}]}]
          (t/is (= "penforge.token-sync.failed.penpot-unreachable"
                   (get-in (ptk/update event {:penforge {:chat chat}})
                           [:penforge :chat :entries 0 :error]))))))))

(t/deftest reload-preview-only-reloads-a-live-preview
  (t/is (= [::preview/reload]
           (mapv ptk/type @(collect (ptk/watch (ts/reload-preview)
                                               (workspace-state :preview-status :ready) nil)))))
  (t/is (empty? @(collect (ptk/watch (ts/reload-preview) (workspace-state) nil)))))

(t/deftest sync-tokens-opens-the-chat-and-runs-the-workflow-with-link-auto
  (let [stream (rx/subject)
        state  (workspace-state :connected true)
        events (collect (ptk/watch (ts/sync-tokens) state stream))
        run    (some #(when (= ::chat/run-workflow (ptk/type %)) %) @events)]
    (t/is (= ::chat/open-chat (ptk/type (first @events))))
    (let [state' (ptk/update run state)
          rid    (-> state' (get-in [:penforge :chat :pending-runs]) keys first)]
      (t/is (= {:name "token-sync" :silent false}
               (get-in state' [:penforge :chat :pending-runs rid])))
      (rx/push! stream (ptk/data-event ::client/message
                                       {:type "workflow.started" :rid rid :run-id "run-1"
                                        :name "token-sync"}))
      (rx/push! stream (ptk/data-event ::client/message
                                       {:type "workflow.event" :run-id "run-1" :kind "result"
                                        :payload {:outcome "updated" :theme-changed true}}))
      (t/is (= ::ts/reload-preview (ptk/type (last @events)))))
    (rx/end! stream)))

(t/deftest the-watcher-sync-is-silent-and-needs-a-connected-editor
  (let [stream (rx/subject)
        state  (workspace-state :connected true)
        events (collect (ptk/watch (ts/sync-after-change) state stream))
        run    (first @events)
        state' (ptk/update run state)]
    (t/is (= ::chat/run-workflow (ptk/type run)))
    (t/is (= [{:name "token-sync" :silent true}]
             (vals (get-in state' [:penforge :chat :pending-runs]))))
    (rx/end! stream))
  (t/is (empty? @(collect (ptk/watch (ts/sync-after-change) (workspace-state) (rx/subject)))))
  (t/is (empty? @(collect (ptk/watch (ts/sync-after-change)
                                     (workspace-state :connected true :can-edit false)
                                     (rx/subject))))))

(t/deftest only-a-real-token-change-triggers-the-watcher
  (let [lib-a #js {}
        lib-b #js {}]
    (t/is (not (ts/token-change? nil lib-a)) "the file loads")
    (t/is (not (ts/token-change? lib-a nil)) "the file closes")
    (t/is (not (ts/token-change? lib-a lib-a)))
    (t/is (ts/token-change? lib-a lib-b))
    (t/is (not (ts/token-change? {:a 1} {:a 1})) "equal values")))
