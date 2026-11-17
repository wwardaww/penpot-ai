;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-adapt-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.adapt :as adapt]
   [app.main.data.ai.actions.all]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [potok.v2.core :as ptk]))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private desktop-id (uuid/next))
(def ^:private mobile-id (uuid/next))
(def ^:private nested-id (uuid/next))
(def ^:private rect-id (uuid/next))

(def ^:private objects
  {uuid/zero  {:id uuid/zero :type :frame :frame-id uuid/zero :parent-id uuid/zero}
   desktop-id {:id desktop-id :type :frame :frame-id uuid/zero :parent-id uuid/zero
               :width 1440 :height 1024}
   mobile-id  {:id mobile-id :type :frame :frame-id uuid/zero :parent-id uuid/zero
               :width 390 :height 844}
   nested-id  {:id nested-id :type :frame :frame-id desktop-id :parent-id desktop-id
               :width 1200 :height 400}
   rect-id    {:id rect-id :type :rect :frame-id uuid/zero :parent-id uuid/zero
               :width 1440 :height 100}})

(def ^:private team-id (uuid/next))

(defn- state-with
  ([selected]
   (state-with selected true))
  ([selected can-edit]
   {:current-file-id file-id
    :current-page-id page-id
    :current-team-id team-id
    :teams {team-id {:id team-id :permissions {:can-edit can-edit}}}
    :files {file-id {:data {:pages-index {page-id {:id page-id :objects objects}}}}}
    :workspace-local {:selected (set selected)}}))

(defn- visible-ids
  [state]
  (->> (actions/get-actions @actions/registry :context-menu state)
       (map :id)
       (filter #{:ai/adapt-mobile :ai/adapt-desktop})
       (set)))

(t/deftest selected-board-needs-exactly-one-top-level-board
  (t/is (= desktop-id (:id (adapt/selected-board (state-with [desktop-id])))))
  (t/is (= mobile-id (:id (adapt/selected-board (state-with [mobile-id])))))
  (t/is (nil? (adapt/selected-board (state-with []))))
  (t/is (nil? (adapt/selected-board (state-with [desktop-id mobile-id]))))
  (t/is (nil? (adapt/selected-board (state-with [nested-id]))))
  (t/is (nil? (adapt/selected-board (state-with [rect-id])))))

(t/deftest the-target-follows-the-board-width
  (t/is (= :mobile (adapt/target-for {:width 1440})))
  (t/is (= :mobile (adapt/target-for {:width 768})))
  (t/is (= :desktop (adapt/target-for {:width 390})))
  (t/is (= :desktop (adapt/target-for {:width 412})))
  (t/is (true? (adapt/can-adapt? (state-with [desktop-id]) :mobile)))
  (t/is (false? (adapt/can-adapt? (state-with [desktop-id]) :desktop)))
  (t/is (false? (adapt/can-adapt? (state-with []) :mobile))))

(t/deftest context-menu-shows-the-matching-action
  (t/is (= #{:ai/adapt-mobile} (visible-ids (state-with [desktop-id]))))
  (t/is (= #{:ai/adapt-desktop} (visible-ids (state-with [mobile-id]))))
  (t/is (= #{} (visible-ids (state-with [rect-id]))))
  (t/is (= #{} (visible-ids (state-with [desktop-id mobile-id]))))
  (doseq [id [:ai/adapt-mobile :ai/adapt-desktop]]
    (let [action (get @actions/registry id)]
      (t/is (string? (actions/get-label action)))
      (t/is (contains? (:scopes action) :command-palette)))))

(t/deftest actions-need-edit-rights
  (let [action (get @actions/registry :ai/adapt-mobile)]
    (t/is (true? (actions/enabled? action (state-with [desktop-id]))))
    (t/is (false? (actions/enabled? action (state-with [desktop-id] false))))
    (t/is (false? (actions/enabled? action (assoc-in (state-with [desktop-id])
                                                     [:workspace-global :read-only?] true))))))

(t/deftest workflow-params-are-strings
  (t/is (= {:board-id (str desktop-id) :target "mobile"}
           (adapt/workflow-params desktop-id :mobile))))

(t/deftest result-payload-is-the-result-event-with-a-board
  (t/is (true? (adapt/result-payload? {:type "workflow.event" :kind "result"
                                       :payload {:board-id "b"}})))
  (t/is (false? (adapt/result-payload? {:type "workflow.event" :kind "progress"
                                        :payload {:text "x"}})))
  (t/is (false? (adapt/result-payload? {:type "workflow.done" :ok true}))))

(t/deftest show-boards-selects-the-new-board-on-the-current-page
  (let [state  (state-with [desktop-id])
        events (atom [])
        event  (adapt/show-boards {:board-id (str mobile-id)
                                   :source-id (str desktop-id)})]
    (rx/sub! (ptk/watch event state (rx/empty)) #(swap! events conj %))
    (t/is (= [:app.main.data.workspace.selection/select-shape
              :app.main.data.workspace.zoom/fit-to-shapes]
             (mapv ptk/type @events))))
  (let [events (atom [])
        event  (adapt/show-boards {:board-id (str (uuid/next))})]
    (rx/sub! (ptk/watch event (state-with []) (rx/empty)) #(swap! events conj %))
    (t/is (= [] @events))))

(defn- daemon-message
  [message]
  (ptk/data-event :app.main.data.ai.client/message message))

(defn- chat-state
  []
  {:penforge
   {:chat {:entries [{:kind :workflow :id "run-1" :name "adapt-responsive"
                      :status :running :progress {:text "Copying the board"}}
                     {:kind :question :id "q-1" :run-id "run-1" :text "English?"
                      :options [{:id "create" :label "Make another"}
                                {:id "cancel" :label "Cancel"}
                                {:id "other" :label "Other"}]}
                     {:kind :workflow :id "run-2" :progress {:text "untouched"}}]}}})

(defn- apply-localized
  [state acc]
  (if-let [event (adapt/localize acc)]
    (ptk/update event state)
    state))

(defn- entry
  [state id]
  (->> (get-in state [:penforge :chat :entries])
       (filter #(= id (:id %)))
       (first)))

(t/deftest localize-translates-the-run-entries
  (let [plan   {:code "exists" :target "mobile" :source-name "Landing"
                :existing ["Landing / Mobile"]}
        state  (-> (chat-state)
                   (apply-localized {:message {:type "workflow.event" :run-id "run-1"
                                               :kind "progress"
                                               :payload {:code "reflow" :text "Reflowing"}}})
                   (apply-localized {:message {:type "workflow.event" :run-id "run-1"
                                               :kind "question"
                                               :payload {:question-id "q-1"}}
                                     :plan plan})
                   (apply-localized {:message {:type "workflow.done" :run-id "run-1" :ok true}
                                     :result {:status "created" :name "Landing / Mobile"
                                              :width 390 :height 1592 :issue-count 0}}))]
    (t/is (= {:text (tr "penforge.adapt.progress.reflow")}
             (:progress (entry state "run-1"))))
    (t/is (= (tr "penforge.adapt.summary.done" "Landing / Mobile" 390 1592)
             (:summary (entry state "run-1"))))
    (t/is (= (tr "penforge.adapt.exists-mobile" "Landing" "\"Landing / Mobile\"")
             (:text (entry state "q-1"))))
    (t/is (= [(tr "penforge.adapt.option.create") (tr "penforge.adapt.option.cancel") "Other"]
             (mapv :label (:options (entry state "q-1")))))
    (t/is (= {:text "untouched"} (:progress (entry state "run-2"))))))

(t/deftest localize-ignores-what-it-does-not-know
  (t/is (nil? (adapt/localize {:message {:type "workflow.event" :kind "progress"
                                         :payload {:text "tool"}}})))
  (t/is (nil? (adapt/localize {:message {:type "workflow.event" :kind "question"
                                         :payload {:question-id "q"}}})))
  (t/is (nil? (adapt/localize {:message {:type "workflow.done" :ok false}
                               :result {:status "created" :name "x"}})))
  (t/is (= (tr "penforge.adapt.summary.issues" "M" 390 900 2)
           (adapt/summary-text {:status "created" :name "M" :width 390 :height 900
                                :issue-count 2})))
  (t/is (= (tr "penforge.adapt.summary.kept" "\"A\", \"B\"")
           (adapt/summary-text {:status "kept" :existing ["A" "B"]})))
  (t/is (nil? (adapt/progress-text "unknown")))
  ;; leaves the state alone when the chat has no entries
  (let [event (adapt/localize {:message {:type "workflow.event" :run-id "r"
                                         :kind "progress" :payload {:code "copy"}}})]
    (t/is (= {} (ptk/update event {})))))

(t/deftest adapt-board-runs-the-workflow-and-shows-the-result
  (let [rid    "rid-1"
        stream (rx/subject)
        events (atom [])
        event  (adapt/adapt-board desktop-id :mobile rid)]
    (rx/sub! (ptk/watch event (state-with [desktop-id]) stream) #(swap! events conj %))
    (t/is (= [:app.main.data.ai.chat/open-chat
              :app.main.data.ai.chat/run-workflow]
             (mapv ptk/type @events)))
    (rx/push! stream (daemon-message {:type "workflow.started" :rid rid
                                      :run-id "run-1" :name "adapt-responsive"}))
    (rx/push! stream (daemon-message {:type "workflow.event" :run-id "run-1"
                                      :kind "progress" :payload {:code "copy" :text "…"}}))
    (rx/push! stream (daemon-message {:type "workflow.event" :run-id "run-2"
                                      :kind "result"
                                      :payload {:board-id "other"}}))
    (rx/push! stream (daemon-message {:type "workflow.event" :run-id "run-1"
                                      :kind "result"
                                      :payload {:status "created"
                                                :board-id (str mobile-id)
                                                :source-id (str desktop-id)}}))
    (rx/push! stream (daemon-message {:type "workflow.done" :run-id "run-1" :ok true
                                      :summary "Made"}))
    (t/is (= [:app.main.data.ai.chat/open-chat
              :app.main.data.ai.chat/run-workflow
              ::adapt/update-entries
              ::adapt/show-boards
              ::adapt/update-entries]
             (mapv ptk/type @events)))))
