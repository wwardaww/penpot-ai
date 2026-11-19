;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-design-system-extract-test
  "Design system from an existing project (W36): marker, proposal list
  helpers, the run state machine and the action guard."
  (:require
   [app.main.data.ai.actions.design-system-extract :as dsx]
   [app.main.data.ai.design-system :as ds]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]))

(def ^:private proposals
  [{:id "merge:#1e88e5" :kind "merge-colors" :code "merge-colors"
    :params {:count 3 :colors ["#1e88e5" "#1d87e4" "#1f89e6"] :keep "#1e88e5" :token "color.brand-blue"}
    :text "3 colors are almost the same"}
   {:id "color:#1e88e5" :kind "color-token" :code "color-token" :params {:hex "#1e88e5"} :text "t"}
   {:id "spacing:16" :kind "token" :code "spacing-token" :params {:value 16} :text "t"}
   {:id "component:g1" :kind "component" :code "component-variants" :params {:name "Card"} :text "t"}
   {:id "icons" :kind "icons" :code "icons" :params {:count 2} :text "t"}
   {:id "unused:color:c3" :kind "drop-unused" :code "unused-color" :params {:name "Pink"} :text "t"}
   {:id "text:inter|16|400" :kind "text-style" :code "text-style" :params {} :text "t"}])

(t/deftest marker-of-a-copy-holds-its-source
  (let [marker (ds/parse-marker (dsx/marker-json "Shop DS" "2026-11-19T10:00:00.000Z"
                                                 {:file-id #uuid "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"
                                                  :project-id #uuid "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
                                                  :revn 12}))]
    (t/is (= "Shop DS" (:name marker)))
    (t/is (= 1 (:version marker)))
    (t/is (= {:file-id "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"
              :project-id "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
              :revn 12}
             (:source marker)))
    (t/is (dsx/extract-pending? marker))
    (t/is (not (dsx/extract-pending? (assoc marker :extracted-at "2026-11-19T11:00:00Z"))))
    (t/is (not (dsx/extract-pending? {:name "Generated" :generated-at "x"})))
    (t/is (not (dsx/extract-pending? nil)))))

(t/deftest source-files-exclude-design-systems
  (t/is (dsx/source-file? {:id 1} {:name "Shop"}))
  (t/is (not (dsx/source-file? {:id 1} {:name ds/project-name})))
  (t/is (not (dsx/source-file? {:id 1 :deleted-at "x"} {:name "Shop"})))
  (t/is (not (dsx/source-file? nil {:name "Shop"}))))

(t/deftest default-name-uses-the-project-then-the-file
  (t/is (string? (dsx/default-name "Shop" "Home")))
  (t/is (string? (dsx/default-name nil "Home")))
  (t/is (string? (dsx/default-name "" nil))))

(t/deftest proposals-are-grouped-in-display-order
  (t/is (= [:colors :text :tokens :components :icons :cleanup]
           (mapv first (dsx/grouped-proposals proposals))))
  (t/is (= ["merge:#1e88e5" "color:#1e88e5"]
           (mapv :id (second (first (dsx/grouped-proposals proposals)))))))

(t/deftest proposal-texts-are-translated-by-code
  (doseq [proposal proposals]
    (t/is (str/starts-with? (dsx/proposal-text proposal) "penforge.design-system-extract.proposal.")
          (:code proposal)))
  (t/is (= "fallback" (dsx/proposal-text {:code "something-new" :text "fallback"}))))

(t/deftest unchecked-proposals-are-skipped
  (t/is (= ["spacing:16" "icons"]
           (dsx/skip-ids (take 5 proposals) #{"merge:#1e88e5" "color:#1e88e5" "component:g1"}))))

(def ^:private plan-payload
  {:mode "plan" :plan-id "abc123abc123" :name "Shop DS"
   :stats {:screens 5} :proposals proposals})

(t/deftest plan-run-lists-every-proposal-checked
  (let [state (-> {:file-id "f" :status :planning}
                  (dsx/next-state {:type "workflow.started" :run-id "r"})
                  (dsx/next-state {:type "workflow.event" :kind "progress" :payload {:text "Looking"}})
                  (dsx/next-state {:type "workflow.event" :kind "plan" :payload plan-payload})
                  (dsx/next-state {:type "workflow.event" :kind "result" :payload plan-payload})
                  (dsx/next-state {:type "workflow.done" :ok true}))]
    (t/is (= :ready (:status state)))
    (t/is (= "abc123abc123" (get-in state [:plan :plan-id])))
    (t/is (= (count proposals) (count (:checked state))))
    (t/is (nil? (:progress state)))))

(t/deftest a-changed-file-shows-the-new-list
  (let [state (-> {:file-id "f" :status :applying :plan {:plan-id "old"} :checked #{}}
                  (dsx/next-state {:type "workflow.event" :kind "plan" :payload plan-payload})
                  (dsx/next-state {:type "workflow.event" :kind "failed" :payload {:code "plan-changed"}})
                  (dsx/next-state {:type "workflow.done" :ok false :error "plan-changed"}))]
    (t/is (= :ready (:status state)))
    (t/is (= "plan-changed" (:notice state)))
    (t/is (= "abc123abc123" (get-in state [:plan :plan-id])))
    (t/is (= (count proposals) (count (:checked state))) "the new list starts all checked")))

(t/deftest apply-run-ends-done-or-with-an-error
  (let [done (-> {:file-id "f" :status :applying}
                 (dsx/next-state {:type "workflow.event" :kind "result" :payload {:mode "apply" :publish true}})
                 (dsx/next-state {:type "workflow.done" :ok true}))
        failed (-> {:file-id "f" :status :planning}
                   (dsx/next-state {:type "workflow.event" :kind "failed" :payload {:code "not-a-copy"}})
                   (dsx/next-state {:type "workflow.done" :ok false}))
        refused (dsx/next-state {:status :planning} {:type "error" :code "busy"})]
    (t/is (= :done (:status done)))
    (t/is (true? (get-in done [:result :publish])))
    (t/is (= :error (:status failed)))
    (t/is (= "not-a-copy" (:error failed)))
    (t/is (= :error (:status refused)))
    (t/is (= "busy" (:error refused)))
    (t/is (string? (dsx/error-text "not-a-copy")))
    (t/is (string? (dsx/error-text "anything")))))

(t/deftest state-belongs-to-the-open-file
  (t/is (= {:status :idle} (dsx/current {:current-file-id "b"
                                         :penforge {:design-system-extract {:file-id "a" :status :ready}}})))
  (t/is (= :ready (:status (dsx/current {:current-file-id "a"
                                         :penforge {:design-system-extract {:file-id "a" :status :ready}}})))))

(t/deftest action-is-hidden-in-design-systems-and-while-a-run-goes
  (let [file-id #uuid "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
        base    {:current-file-id file-id
                 :current-project-id #uuid "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
                 :permissions {:can-edit true}
                 :projects {#uuid "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" {:name "Shop"}}
                 :files {file-id {:id file-id :data {}}}}
        running (assoc-in base [:penforge :chat :runs "r"] {:status :running})
        in-ds   (assoc-in base [:projects #uuid "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" :name] ds/project-name)
        viewer  (assoc-in base [:permissions :can-edit] false)]
    (t/is (not (dsx/action-visible? running)))
    (t/is (not (dsx/action-visible? in-ds)))
    (t/is (not (dsx/action-visible? viewer)))))
