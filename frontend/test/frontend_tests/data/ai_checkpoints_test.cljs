;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-checkpoints-test
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom/server" :as rds]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.checkpoints :as dac]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.checkpoints.history :as history]
   [app.util.globals :as globals]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [rumext.v2 :as mf]))

(def ^:private file-id "a1e7f4b2-0c1d-4e5f-8a9b-1c2d3e4f5a6b")

(def ^:private cp-1
  {:id "cp-1" :n 1 :label "Before fixing comments" :workflow "fix-comments"
   :at "2026-11-17T10:00:00.000Z"
   :file-version {:file-id file-id :file-name "Shop" :label "AI checkpoint #1 · Before fixing comments"
                  :created-at "2026-11-17T10:00:00.000Z"}
   :design-sha "a" :app-sha "b" :tag "penforge-cp-1" :restored-at "2026-11-17T11:00:00.000Z"})

(def ^:private cp-2
  {:id "cp-2" :n 2 :label "Before going back to #1" :workflow "checkpoint-restore"
   :at "2026-11-17T11:00:00.000Z" :file-version nil
   :warnings ["The design version could not be saved: no plugin"]
   :design-sha "c" :app-sha "d" :tag "penforge-cp-2"})

(def ^:private cp-3
  {:id "cp-3" :n 3 :label "Before generating a login screen" :workflow "generate-screen"
   :at "2026-11-17T12:00:00.000Z"
   :file-version {:file-id "other" :file-name "Landing" :label "AI checkpoint #3" :created-at nil}
   :design-sha "e" :app-sha "f" :tag "penforge-cp-3"})

(def ^:private listing
  {:checkpoints [cp-3 cp-2 cp-1] :undo-target-id "cp-3"})

(t/deftest apply-listing-stores-the-items-and-the-undo-target
  (let [state (dac/apply-listing (assoc dac/empty-state :status :loading :busy "cp-1") listing)]
    (t/is (= :loaded (:status state)))
    (t/is (= ["cp-3" "cp-2" "cp-1"] (mapv :id (:items state))))
    (t/is (= "cp-1" (:busy state)))
    (t/is (= cp-3 (dac/undo-target state)))
    (t/is (= cp-2 (dac/find-checkpoint state "cp-2")))
    (t/is (nil? (dac/undo-target (dac/apply-listing dac/empty-state {:checkpoints [] :undo-target-id nil}))))))

(t/deftest other-file-and-code-only
  (t/is (false? (dac/other-file? cp-1 file-id)))
  (t/is (false? (dac/other-file? cp-1 (uuid file-id))))
  (t/is (true? (dac/other-file? cp-3 file-id)))
  (t/is (false? (dac/other-file? cp-2 file-id)))
  (t/is (true? (dac/code-only? cp-2)))
  (t/is (false? (dac/code-only? cp-1))))

(t/deftest workflow-label-names-known-workflows
  (t/is (string? (dac/workflow-label "fix-comments")))
  (t/is (not= (dac/workflow-label "manual") (dac/workflow-label "checkpoint-restore")))
  ;; tests have no translations loaded, so `tr` answers the key
  (t/is (= "penforge.checkpoints.workflow.other" (dac/workflow-label "something-new"))))

(t/deftest run-outcome-reduces-a-run
  (let [reduce-run #(reduce dac/run-outcome {:done false} %)]
    (t/is (= {:done true :ok true :result {:checkpoints []} :summary "0" :error nil}
             (reduce-run [{:type "workflow.started" :run-id "r"}
                          {:type "workflow.event" :kind "progress" :payload {:text "x"}}
                          {:type "workflow.event" :kind "result" :payload {:checkpoints []}}
                          {:type "workflow.done" :ok true :summary "0"}])))
    (t/is (= {:done true :ok false :error "boom" :summary "Could not finish"}
             (reduce-run [{:type "workflow.started" :run-id "r"}
                          {:type "workflow.done" :ok false :summary "Could not finish" :error "boom"}])))
    (t/is (= {:done true :ok false :error "Unknown workflow"}
             (reduce-run [{:type "error" :code "unknown-workflow" :message "Unknown workflow"}])))
    (t/is (= {:done false} (reduce-run [])))))

(def ^:private team-id (uuid "6f1d2c3b-4a5e-4f60-8a71-9b2c3d4e5f60"))

(defn- team-state
  [can-edit]
  {:current-team-id team-id
   :teams {team-id {:id team-id :permissions {:can-edit can-edit}}}})

(t/deftest can-edit-needs-edit-permission-and-a-writable-workspace
  (t/is (true? (dac/can-edit? (team-state true))))
  (t/is (false? (dac/can-edit? (team-state false))))
  (t/is (false? (dac/can-edit? (assoc-in (team-state true) [:workspace-global :read-only?] true))))
  (t/is (false? (dac/can-edit? {}))))

(t/deftest actions-are-registered-for-editors-only
  (let [registry @actions/registry
        editor   (team-state true)
        viewer   (team-state false)]
    (t/is (some #(= :ai/undo-last (:id %)) (actions/get-actions registry :header editor)))
    (t/is (some #(= :ai/checkpoints (:id %)) (actions/get-actions registry :main-menu editor)))
    (t/is (some #(= :ai/undo-last (:id %)) (actions/get-actions registry :command-palette editor)))
    (t/is (not-any? #(contains? #{:ai/undo-last :ai/checkpoints} (:id %))
                    (concat (actions/get-actions registry :header viewer)
                            (actions/get-actions registry :main-menu viewer)
                            (actions/get-actions registry :command-palette viewer))))
    (t/is (false? (actions/enabled? (get registry :ai/undo-last) editor)))
    (t/is (true? (actions/enabled? (get registry :ai/undo-last)
                                   (assoc editor :penforge {:connection {:status :connected}}))))))

(t/deftest the-dialog-is-registered-as-a-modal
  (t/is (fn? (get @modal/components dac/modal-type))))

;; --- Rendering

(defn- render-list
  [checkpoints connected]
  (rds/renderToStaticMarkup
   (mf/element history/checkpoint-list*
               #js {:checkpoints checkpoints
                    :developer false
                    :connected connected
                    :fileId file-id})))

(t/deftest the-list-renders-every-state
  (t/is (str/includes? (render-list dac/empty-state false)
                       "penforge.checkpoints.not-connected"))
  (t/is (str/includes? (render-list (assoc dac/empty-state :status :loading) true)
                       "penforge.checkpoints.loading"))
  (t/is (str/includes? (render-list (assoc dac/empty-state :status :error) true)
                       "penforge.checkpoints.load-failed"))
  (t/is (str/includes? (render-list (assoc dac/empty-state :status :loaded) true)
                       "penforge.checkpoints.empty")))

(defn- render-items
  [can-edit]
  (rds/renderToStaticMarkup
   (mf/element history/checkpoint-list*
               #js {:checkpoints (dac/apply-listing dac/empty-state listing)
                    :developer false
                    :canEdit can-edit
                    :connected true
                    :fileId file-id})))

(t/deftest the-list-renders-checkpoints
  (let [markup (render-items true)]
    (t/is (= 3 (count (re-seq #"data-testid=\"ai-checkpoint\"" markup))))
    (t/is (str/includes? markup "#3 · Before generating a login screen"))
    (t/is (str/includes? markup "#1 · Before fixing comments"))
    (t/is (= 3 (count (re-seq #">penforge.checkpoints.restore<" markup))))
    (t/is (not (str/includes? markup "ai-checkpoint-diff")))))

(t/deftest viewers-see-the-list-without-go-back
  (let [markup (render-items false)]
    (t/is (= 3 (count (re-seq #"data-testid=\"ai-checkpoint\"" markup))))
    (t/is (not (str/includes? markup ">penforge.checkpoints.restore<")))))

(t/deftest the-list-shows-the-diff-to-developers
  (let [diff   {:status :loaded
                :data {:checkpoint cp-1
                       :design {:stat "" :patch "" :truncated false :untracked []}
                       :app-src {:stat " index.html | 2 +-" :patch "-<h1>v1</h1>\n+<h1>v2</h1>\n"
                                 :truncated true :untracked ["new.js"]}}}
        state  (-> (dac/apply-listing dac/empty-state listing)
                   (assoc-in [:diffs "cp-1"] diff)
                   (assoc :busy "cp-1"))
        markup (rds/renderToStaticMarkup
                (mf/element history/checkpoint-list*
                            #js {:checkpoints state
                                 :developer true
                                 :canEdit true
                                 :connected true
                                 :fileId file-id}))]
    (t/is (= 1 (count (re-seq #"data-testid=\"ai-checkpoint-diff\"" markup))))
    (t/is (str/includes? markup "index.html | 2 +-"))
    (t/is (str/includes? markup "new.js"))
    (t/is (str/includes? markup "penforge.checkpoints.diff.truncated"))
    (t/is (str/includes? markup "penforge.checkpoints.restoring"))))

(t/deftest ^:async the-dialog-renders-from-the-store
  ;; The close button's tooltip needs a document, which the runner lacks.
  ;; Only the dialog shell is checked: other test namespaces `set!`
  ;; st/state to a new atom, so the dialog's refs may watch an older
  ;; one in a full run. The list content is covered above.
  (let [window   (.-window (JSDOM. "<!doctype html><html><body></body></html>"))
        document (.-document window)
        previous @st/state]
    (try
      (await
       (mock/with-mocks* {globals/document document globals/window window}
         ;; set in the same tick as the render: the mock body runs deferred
         (swap! st/state assoc
                :current-file-id (uuid file-id)
                :penforge {:connection {:status :connected}
                           :checkpoints (dac/apply-listing dac/empty-state listing)})
         (let [markup (rds/renderToStaticMarkup (mf/element history/checkpoints-dialog* #js {}))]
           (t/is (str/includes? markup "ai-checkpoints-dialog"))
           (t/is (str/includes? markup "penforge.checkpoints.title"))
           (t/is (str/includes? markup "penforge.checkpoints.intro")))))
      (finally
        (reset! st/state previous)
        (.close window)))))
