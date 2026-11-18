;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-prototype-test
  "Wire prototype (W27): action registration, selected screens and the
  dialog state from proposal to applied links."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.prototype :as prototype]
   [app.main.ui.workspace.ai.prototype.dialog :as dialog]
   [cljs.test :as t :include-macros true]))

(def ^:private home-id (uuid/next))
(def ^:private add-id (uuid/next))
(def ^:private button-id (uuid/next))

(def ^:private objects
  {uuid/zero {:id uuid/zero :type :frame :frame-id uuid/zero}
   home-id   {:id home-id :type :frame :frame-id uuid/zero :parent-id uuid/zero}
   add-id    {:id add-id :type :frame :frame-id uuid/zero :parent-id uuid/zero}
   button-id {:id button-id :type :rect :frame-id home-id :parent-id home-id}})

(def ^:private proposal
  {:mode "proposal"
   :page-id "p1"
   :links [{:source-id "plus" :action "navigate-to" :destination-id "add"
            :source-name "Add Button" :board-name "Home" :destination-name "Add Task"
            :reason "+ opens the form"}
           {:source-id "back" :action "previous-screen" :destination-id nil
            :source-name "Back" :board-name "Add Task" :destination-name nil}]
   :flow {:name "Tasks" :starting-board-id "home" :starting-board-name "Home"}})

(t/deftest action-is-registered-for-menus-and-palette
  (let [action (get @actions/registry :ai/wire-prototype)]
    (t/is (some? action))
    (t/is (= #{:context-menu :main-menu :command-palette} (:scopes action)))))

(t/deftest selected-screen-ids-needs-two-top-level-boards
  (t/is (= [(str home-id) (str add-id)]
           (prototype/selected-screen-ids objects [home-id button-id add-id])))
  (t/is (nil? (prototype/selected-screen-ids objects [home-id button-id])))
  (t/is (nil? (prototype/selected-screen-ids objects []))))

(t/deftest propose-params-sends-page-and-screens
  (t/is (= {:page-id "p1"} (dialog/propose-params {:page-id "p1" :board-ids nil})))
  (t/is (= {:page-id "p1" :board-ids ["a" "b"]}
           (dialog/propose-params {:page-id "p1" :board-ids ["a" "b"]}))))

(defn- run-messages
  [state messages]
  (reduce dialog/next-state state messages))

(t/deftest proposal-reaches-review-with-everything-checked
  (let [state (run-messages {:step :running}
                            [{:type "workflow.started" :run-id "r1"}
                             {:type "workflow.event" :kind "result" :payload proposal}
                             {:type "workflow.done" :ok true :summary "Proposed 2"}])]
    (t/is (= :review (:step state)))
    (t/is (nil? (:run-id state)))
    (t/is (= #{"plus" "back"} (:checked state)))
    (t/is (true? (:flow-checked state)))
    (t/is (= "Home › Add Button → Add Task" (dialog/link-label (first (:links state)))))))

(t/deftest empty-proposal-and-errors
  (let [empty-state (run-messages {:step :running}
                                  [{:type "workflow.event" :kind "result"
                                    :payload {:mode "proposal" :links [] :flow nil
                                              :reason "needs-two-screens"}}
                                   {:type "workflow.done" :ok true}])
        failed (run-messages {:step :running}
                             [{:type "workflow.done" :ok false :error "busy"}])]
    (t/is (= :empty (:step empty-state)))
    (t/is (= "needs-two-screens" (:reason empty-state)))
    (t/is (= :error (:step failed)))
    (t/is (= "busy" (:error failed)))))

(t/deftest apply-params-keep-only-checked-links-and-flow
  (let [state (-> (run-messages {:step :running :page-id "p1"}
                                [{:type "workflow.event" :kind "result" :payload proposal}
                                 {:type "workflow.done" :ok true}])
                  (update :checked disj "back")
                  (assoc :flow-checked false))]
    (t/is (= {:apply true
              :page-id "p1"
              :links [{:source-id "plus" :action "navigate-to" :destination-id "add"}]}
             (dialog/apply-params state))))
  (let [state (run-messages {:step :running}
                            [{:type "workflow.event" :kind "result" :payload proposal}
                             {:type "workflow.done" :ok true}])]
    (t/is (= {:name "Tasks" :starting-board-id "home"}
             (:flow (dialog/apply-params state))))))

(t/deftest applied-run-reports-counts
  (let [results [{:op "add-interaction" :status "added"}
                 {:op "add-interaction" :status "conflict"}
                 {:op "set-flow" :status "added"}]
        state (run-messages {:step :applying}
                            [{:type "workflow.event" :kind "result"
                              :payload {:mode "applied" :results results}}
                             {:type "workflow.done" :ok true}])]
    (t/is (= :done (:step state)))
    (t/is (= {:wired 1 :kept 1 :flow true} (dialog/result-counts (:results state))))
    (t/is (= {:wired 0 :kept 0 :flow false}
             (dialog/result-counts [{:op "set-flow" :status "skipped"}])))))
