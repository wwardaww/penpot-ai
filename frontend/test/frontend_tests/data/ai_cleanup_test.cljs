;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-cleanup-test
  "Tidy-up (W17): the registered action, its workflow params, and the
  translated progress and summary of a run in the chat."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.cleanup :as cleanup]
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [clojure.string :as str]
   [potok.v2.core :as ptk]))

(def ^:private page-id (uuid/next))
(def ^:private team-id (uuid/next))
(def ^:private shape-id (uuid/next))

(defn- state-with
  ([selected]
   (state-with selected true))
  ([selected can-edit]
   {:current-page-id page-id
    :current-team-id team-id
    :teams {team-id {:id team-id :permissions {:can-edit can-edit}}}
    :workspace-local {:selected (set selected)}}))

(t/deftest the-action-is-registered-for-editors
  (let [action (get @actions/registry :ai/tidy-up)]
    (t/is (some? action))
    (t/is (= (tr "penforge.actions.tidy-up") (actions/get-label action)))
    (t/is (contains? (:scopes action) :context-menu))
    (t/is (contains? (:scopes action) :main-menu))
    (t/is (true? (actions/enabled? action (state-with []))))
    (t/is (false? (actions/enabled? action (state-with [] false))))
    (t/is (false? (actions/enabled? action (assoc-in (state-with [])
                                                     [:workspace-global :read-only?] true))))))

(t/deftest params-use-the-selection-or-the-page
  (t/is (= {:scope "selection" :node-ids [(str shape-id)] :page-id (str page-id)}
           (cleanup/workflow-params (state-with [shape-id]) [shape-id])))
  (t/is (= {:scope "page" :page-id (str page-id)}
           (cleanup/workflow-params (state-with []) []))))

(t/deftest progress-and-errors-are-translated
  (t/is (= (tr "penforge.cleanup.progress.layout" "Home")
           (cleanup/progress-text {:step "layout" :params {:board "Home"} :text "Adding"})))
  (t/is (= (tr "penforge.cleanup.progress.names")
           (cleanup/progress-text {:stage "scan" :done 1 :total 0})))
  (t/is (nil? (cleanup/progress-text {:summary "Run execute_code" :status "running"})))
  (t/is (= (tr "penforge.cleanup.error.no-selection")
           (cleanup/error-text "cleanup/no-selection")))
  (t/is (nil? (cleanup/error-text "boom"))))

(t/deftest the-summary-lists-what-changed
  (let [summary (cleanup/summary-text
                 {:page-name "Page 1"
                  :totals {:junk 3 :layouts 4 :layouts-reverted 1 :components 1
                           :instances 3 :components-reverted 0 :renamed 12}
                  :checkpoint {:id "cp-4" :n 4}
                  :notes "Kept the hidden Error state."})]
    (t/is (= (str (tr "penforge.cleanup.summary.title" "Page 1") " "
                  (tr "penforge.cleanup.summary.junk" (i18n/c 3)) " "
                  (tr "penforge.cleanup.summary.layouts" (i18n/c 4)) " "
                  (tr "penforge.cleanup.summary.components" (i18n/c 1)) " "
                  (tr "penforge.cleanup.summary.renamed" (i18n/c 12)) " "
                  (tr "penforge.cleanup.summary.reverted" (i18n/c 1)) " "
                  (tr "penforge.cleanup.summary.checkpoint" 4) " "
                  "Kept the hidden Error state.")
             summary)))
  (t/is (= (tr "penforge.cleanup.summary.nothing")
           (cleanup/summary-text {:page-name "Page 1"
                                  :totals {:junk 0 :layouts 0 :components 0 :renamed 0}
                                  :checkpoint {:id "cp-1" :n 1}}))))

(defn- daemon-message
  [message]
  (ptk/data-event :app.main.data.ai.client/message message))

(defn- chat-state
  []
  {:penforge
   {:chat {:entries [{:kind :workflow :id "run-1" :name "cleanup-import" :status :running}
                     {:kind :workflow :id "run-2" :name "other" :status :running}]
           :runs {"run-1" {:status :running} "run-2" {:status :running}}}}})

(t/deftest tidy-up-runs-the-workflow-and-translates-the-run
  (let [rid    "rid-1"
        stream (rx/subject)
        events (atom [])
        event  (cleanup/tidy-up {:scope "page" :page-id (str page-id)} rid)]
    (rx/sub! (ptk/watch event (state-with []) stream) #(swap! events conj %))
    (t/is (= [:app.main.data.ai.chat/open-chat
              :app.main.data.ai.chat/run-workflow]
             (mapv ptk/type @events)))
    (rx/push! stream (daemon-message {:type "workflow.started" :rid rid
                                      :run-id "run-1" :name "cleanup-import"}))
    (rx/push! stream (daemon-message {:type "workflow.event" :run-id "run-1" :kind "progress"
                                      :payload {:step "junk" :params {:board "Home"} :text "x"}}))
    (rx/push! stream (daemon-message {:type "workflow.event" :run-id "run-1" :kind "result"
                                      :payload {:page-name "Page 1"
                                                :totals {:junk 1 :layouts 0 :components 0
                                                         :renamed 0}}}))
    (rx/push! stream (daemon-message {:type "workflow.done" :run-id "run-1" :ok true
                                      :summary "English"}))
    (let [state (reduce (fn [state event] (ptk/update event state))
                        (chat-state)
                        (drop 2 @events))
          [entry other] (get-in state [:penforge :chat :entries])]
      (t/is (= 2 (count (drop 2 @events))))
      (t/is (= (str (tr "penforge.cleanup.summary.title" "Page 1") " "
                    (tr "penforge.cleanup.summary.junk" (i18n/c 1)))
               (:summary entry)))
      (t/is (= (tr "penforge.cleanup.progress.junk" "Home")
               (get-in entry [:progress :text])
               (get-in state [:penforge :chat :runs "run-1" :progress :text])))
      (t/is (nil? (:summary other))))))

(t/deftest a-failed-run-gets-a-translated-reason
  (let [event (cleanup/localize {:message {:type "workflow.done" :run-id "run-1" :ok false
                                           :error "cleanup/no-selection"}})
        state (ptk/update event (chat-state))]
    (t/is (= (tr "penforge.cleanup.error.no-selection")
             (get-in state [:penforge :chat :entries 0 :summary]))))
  (t/is (nil? (cleanup/localize {:message {:type "workflow.done" :run-id "run-1" :ok false
                                           :error "cancelled"}}))))

(t/deftest the-hidden-layers-question-is-translated
  (let [plan  {:code "hidden" :count 2 :names ["Hover" "Error"]}
        event (cleanup/localize {:message {:type "workflow.event" :run-id "run-1" :kind "question"
                                           :payload {:question-id "q-1"}}
                                 :plan plan})
        state (ptk/update event {:penforge {:chat {:entries [{:kind :question :id "q-1" :text "English"
                                                              :options [{:id "keep" :label "Keep them"}
                                                                        {:id "delete" :label "Delete them"}]}]}}})
        entry (get-in state [:penforge :chat :entries 0])]
    (t/is (= (tr "penforge.cleanup.hidden.question" (i18n/c 2) "Hover, Error") (:text entry)))
    (t/is (= [(tr "penforge.cleanup.hidden.keep") (tr "penforge.cleanup.hidden.delete")]
             (mapv :label (:options entry))))))

(t/deftest the-summary-says-what-was-kept-and-when-it-stopped
  (let [summary (cleanup/summary-text {:page-name "Page 1"
                                       :totals {:junk 1 :layouts 0 :components 0 :renamed 0}
                                       :hidden {:count 3 :removed 1 :names []}
                                       :stopped "time-budget"})]
    (t/is (str/includes? summary (tr "penforge.cleanup.summary.hidden-kept" (i18n/c 2))))
    (t/is (str/includes? summary (tr "penforge.cleanup.summary.stopped")))))

(t/deftest new-errors-are-translated
  (t/is (= (tr "penforge.cleanup.error.checkpoint-failed")
           (cleanup/error-text "cleanup/checkpoint-failed: the file is not in a Penforge project")))
  (t/is (= (tr "penforge.cleanup.error.busy") (cleanup/error-text "cleanup/busy")))
  (t/is (= (tr "penforge.cleanup.error.plan-changed") (cleanup/error-text "cleanup/plan-changed"))))
