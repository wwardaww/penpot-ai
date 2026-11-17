;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-auto-name-test
  "Auto-naming (W16): dialog state, plan and one-step apply/undo of the
  accepted names, and a render of the dialog."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react" :as react]
   ["react-dom/client" :as rdc]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.auto-name :as auto-name]
   [app.main.data.changes :as dch]
   [app.main.data.workspace.undo :as dwu]
   [app.main.ui.workspace.ai.auto-name.dialog :as dialog]
   [app.util.globals :as globals]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [frontend-tests.helpers.state :as ths]
   [okulary.core :as l]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(t/use-fixtures :each
  {:before cthi/reset-idmap!})

;; --- Fixtures

(defn- sample-file
  "Two pages: page 1 holds two default-named layers and a named one,
  page 2 one default-named layer."
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :board :type :frame :name "Board 1")
      (cths/add-sample-shape :rect :name "Rectangle 2" :parent-label :board)
      (cths/add-sample-shape :logo :name "Logo")
      (cthf/add-sample-page :page2)
      (cths/add-sample-shape :circle :type :circle :name "Ellipse 3")
      (cthf/switch-to-page :page1)))

(defn- rename
  [label page-label old-name new-name]
  {:node-id (str (cthi/id label))
   :page-id (str (cthi/id page-label))
   :type "rect"
   :old-name old-name
   :new-name new-name})

(defn- shape-name
  [state label page-label]
  (:name (cths/get-shape (ths/get-file-from-state state) label :page-label page-label)))

;; --- Pure helpers

(t/deftest workflow-params-follow-the-scope
  (t/is (= {:scope "selection" :convention "title" :include-components false :node-ids ["a" "b"]}
           (dialog/workflow-params {:scope :selection :node-ids '("a" "b") :page-id "p"})))
  (t/is (= {:scope "page" :convention "kebab" :include-components true :page-id "p"}
           (dialog/workflow-params {:scope :page :convention :kebab :include-components true
                                    :node-ids ["a"] :page-id "p"})))
  (t/is (= {:scope "file" :convention "bem" :include-components false}
           (dialog/workflow-params {:scope :file :convention :bem}))))

(t/deftest next-state-follows-a-run-to-the-review
  (let [renames [{:node-id "a" :page-id "p" :old-name "Board 1" :new-name "Home"}
                 {:node-id "b" :page-id "p" :old-name "Rectangle 2" :new-name "Card"}]
        state   (reduce dialog/next-state
                        {:step :running}
                        [{:type "workflow.started" :run-id "run-1"}
                         {:type "workflow.event" :kind "progress" :payload {:summary "Reading the design"}}
                         {:type "workflow.event" :kind "progress" :payload {:stage "name" :done 1 :total 2}}
                         {:type "workflow.event" :kind "result"
                          :payload {:renames renames :candidates 2 :remaining 0}}])]
    (t/is (= "run-1" (:run-id state)))
    (t/is (= {:stage "name" :done 1 :total 2} (:progress state)))
    (t/is (= #{"a" "b"} (:checked state)))
    (t/is (= {:candidates 2 :remaining 0} (:result state)))
    (let [done (dialog/next-state state {:type "workflow.done" :run-id "run-1" :ok true})]
      (t/is (= :review (:step done)))
      (t/is (nil? (:run-id done))))))

(t/deftest next-state-reports-empty-runs-and-errors
  (t/is (= :empty (:step (reduce dialog/next-state {:step :running}
                                 [{:type "workflow.event" :kind "result" :payload {:renames []}}
                                  {:type "workflow.done" :ok true}]))))
  (let [failed (dialog/next-state {:step :running}
                                  {:type "workflow.done" :ok false :summary "Could not finish" :error "boom"})]
    (t/is (= :error (:step failed)))
    (t/is (= "boom" (:error failed))))
  (t/is (= "busy" (:error (dialog/next-state {:step :running} {:type "error" :code "busy"})))))

(t/deftest accepted-renames-use-checks-and-edits
  (let [renames [{:node-id "a" :new-name "Home"}
                 {:node-id "b" :new-name "Card"}
                 {:node-id "c" :new-name "Badge"}]]
    (t/is (= [{:node-id "a" :new-name "Hero"} {:node-id "c" :new-name "Badge"}]
             (dialog/accepted-renames {:renames renames
                                       :checked #{"a" "c"}
                                       :edits {"a" "Hero"}})))
    (t/is (= [{:node-id "b" :new-name "Card"}]
             (dialog/accepted-renames {:renames renames
                                       :checked #{"a" "b"}
                                       :edits {"a" ""}})))))

(t/deftest plan-renames-skips-missing-and-changed-layers
  (let [file    (sample-file)
        objects {(cthi/id :page1) (:objects (cthf/get-page file :page1))
                 (cthi/id :page2) (:objects (cthf/get-page file :page2))}
        plan    (auto-name/plan-renames
                 objects
                 [(rename :board :page1 "Board 1" "Home")
                  (rename :rect :page1 "Rectangle 99" "Card")
                  (rename :circle :page2 "Ellipse 3" "  Avatar ")
                  {:node-id "not-a-uuid" :page-id (str (cthi/id :page1)) :old-name "x" :new-name "y"}])]
    (t/is (= [{:page-id (cthi/id :page1) :names {(cthi/id :board) "Home"} :components {}}
              {:page-id (cthi/id :page2) :names {(cthi/id :circle) "Avatar"} :components {}}]
             plan))))

(t/deftest auto-name-action-is-registered
  (let [action (get @actions/registry :ai/auto-name)]
    (t/is (some? action))
    (t/is (= #{:context-menu :main-menu :command-palette} (:scopes action)))))

;; --- Apply and undo

(defn- watch-undo-stack
  "Record undo entries for local commits, as `initialize-workspace` does
  in the app (the test store skips that bootstrap). Stops at `:the/end`."
  []
  (ptk/reify ::watch-undo-stack
    ptk/WatchEvent
    (watch [_ _ stream]
      (->> stream
           (rx/filter dch/commit?)
           (rx/map deref)
           (rx/mapcat
            (fn [{:keys [save-undo? undo-changes redo-changes undo-group tags stack-undo?
                         selected-before translation?]}]
              (if (and save-undo? (seq undo-changes))
                (rx/of (dwu/append-undo {:undo-changes undo-changes
                                         :redo-changes redo-changes
                                         :undo-group undo-group
                                         :tags tags
                                         :selected-before selected-before
                                         :translation (boolean translation?)}
                                        stack-undo?))
                (rx/empty))))
           (rx/take-until (rx/filter #(= :the/end %) stream))))))

(t/deftest apply-renames-is-one-undo-step-over-pages
  (t/async
    done
    (let [store (ths/setup-store (sample-file))
          check-undo
          (fn []
            (ths/run-store
             store done [dwu/undo]
             (fn [state]
               (t/is (= "Board 1" (shape-name state :board :page1)))
               (t/is (= "Rectangle 2" (shape-name state :rect :page1)))
               (t/is (= "Ellipse 3" (shape-name state :circle :page2)))
               (t/is (= "Logo" (shape-name state :logo :page1))))))]
      (ths/run-store
       store check-undo
       [(watch-undo-stack)
        (auto-name/apply-renames [(rename :board :page1 "Board 1" "Home")
                                  (rename :rect :page1 "Rectangle 2" "Card")
                                  (rename :circle :page2 "Ellipse 3" "Avatar")])]
       (fn [state]
         (t/is (= "Home" (shape-name state :board :page1)))
         (t/is (= "Card" (shape-name state :rect :page1)))
         (t/is (= "Avatar" (shape-name state :circle :page2)))
         (t/is (= "Logo" (shape-name state :logo :page1)))
         ;; both page commits are one undo entry
         (t/is (= 1 (count (get-in state [:workspace-undo :items])))))))))

;; --- Render

(defn- ^:async render-dialog
  "Mounts the dialog with `props` while the AI connection has `status`
  and resolves to `{:markup :errors}`. The document comes from jsdom
  since the runner has no DOM."
  [status props]
  (let [dom          (JSDOM. "<!doctype html><html><body><div id='root'></div></body></html>")
        window       (.-window dom)
        document     (.-document window)
        old-window   (.-window js/globalThis)
        old-document (.-document js/globalThis)
        old-act      (.-IS_REACT_ACT_ENVIRONMENT js/globalThis)
        errors       (volatile! [])
        on-error     (fn [error _info] (vswap! errors conj (.-message error)))
        container    (.getElementById document "root")
        markup       (volatile! nil)]
    (set! (.-window js/globalThis) window)
    (set! (.-document js/globalThis) document)
    (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) true)
    (try
      (await
       ;; other test namespaces swap the store, so the connection ref
       ;; is replaced rather than read through `st/state`
       (mock/with-mocks* {globals/document document
                          globals/window window
                          dialog/ref:connected (l/atom (= status :connected))}
         (let [root (rdc/createRoot container #js {:onUncaughtError on-error
                                                   :onCaughtError on-error
                                                   :onRecoverableError on-error})]
           (try
             (await (react/act #(.render root (mf/element dialog/auto-name-dialog props))))
             (vreset! markup (.-innerHTML container))
             (finally
               (await (react/act #(.unmount root))))))))
      (finally
        (.close window)
        (set! (.-window js/globalThis) old-window)
        (set! (.-document js/globalThis) old-document)
        (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) old-act)))
    {:markup @markup
     :errors @errors}))

(t/deftest ^:async dialog-renders-the-setup-step
  (let [{:keys [markup errors]}
        (await (render-dialog :connected {:scope :selection
                                          :node-ids ["a"]
                                          :page-id "p"
                                          :persona :developer
                                          :on-apply identity}))]
    (t/is (empty? errors))
    (t/is (str/includes? markup "penforge-auto-name-scope-selection"))
    (t/is (str/includes? markup "penforge-auto-name-components"))
    ;; developers choose the naming style
    (t/is (str/includes? markup "penforge.auto-name.convention"))))

(t/deftest ^:async dialog-asks-to-connect-first
  (let [{:keys [markup errors]}
        (await (render-dialog :disconnected {:scope :page
                                             :node-ids []
                                             :page-id "p"
                                             :persona :designer
                                             :on-apply identity}))]
    (t/is (empty? errors))
    (t/is (str/includes? markup "penforge.auto-name.not-connected"))
    (t/is (not (str/includes? markup "penforge-auto-name-scope-page")))))
