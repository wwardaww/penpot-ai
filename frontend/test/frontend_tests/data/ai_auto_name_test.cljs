;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-auto-name-test
  "Auto-naming (W16): dialog state, plan and one-step apply/undo of the
  accepted names, and the dialog driven through its real callbacks."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react" :as react]
   ["react-dom/client" :as rdc]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.auto-name :as auto-name]
   [app.main.data.ai.chat :as chat]
   [app.main.data.changes :as dch]
   [app.main.data.workspace.undo :as dwu]
   [app.main.store :as st]
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

(t/deftest apply-all-step-keeps-real-words-for-review
  (let [state {:step :review
               :apply-all true
               :applied 0
               :renames [{:node-id "a" :new-name "Card" :ambiguous false}
                         {:node-id "t" :new-name "Price" :ambiguous true}]}
        {to-apply :apply after :state} (dialog/apply-all-step state)]
    (t/is (= ["a"] (mapv :node-id to-apply)))
    (t/is (= :review (:step after)))
    (t/is (= ["t"] (mapv :node-id (:renames after))))
    (t/is (= #{"t"} (:checked after)))
    (t/is (= 1 (:applied after)))
    (t/is (false? (:apply-all after))))
  (let [{to-apply :apply after :state}
        (dialog/apply-all-step {:renames [{:node-id "a" :new-name "Card"}]})]
    (t/is (= ["a"] (mapv :node-id to-apply)))
    (t/is (= :done (:step after)))
    (t/is (= 1 (:applied after)))))

(t/deftest error-message-translates-codes
  (t/is (= "penforge.auto-name.error.no-selection" (dialog/error-message "auto-name/no-selection")))
  (t/is (= "penforge.auto-name.error.read-failed"
           (dialog/error-message "auto-name/read-failed: No Penpot file is open")))
  (t/is (= "penforge.auto-name.error.busy" (dialog/error-message "busy")))
  (t/is (= "penforge.auto-name.error" (dialog/error-message "something else"))))

(t/deftest plan-renames-never-touches-copies
  (let [file    (-> (cthf/sample-file :file1 :page-label :page1)
                    (cths/add-sample-shape :copied :name "Rectangle 5" :shape-ref (uuid/next)))
        objects {(cthi/id :page1) (:objects (cthf/get-page file :page1))}]
    (t/is (= [] (auto-name/plan-renames objects [(rename :copied :page1 "Rectangle 5" "Card")])))))

(t/deftest action-needs-edit-permission
  (let [action (get @actions/registry :ai/auto-name)]
    (t/is (true? (actions/enabled? action {:permissions {:can-edit true}})))
    (t/is (false? (actions/enabled? action {:permissions {:can-edit false}})))
    (t/is (false? (actions/enabled? action {:permissions {:can-edit true}
                                            :workspace-global {:read-only? true}})))
    (t/is (not-any? #(= :ai/auto-name (:id %))
                    (actions/get-actions @actions/registry :context-menu
                                         {:permissions {:can-edit false}})))))

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

;; --- Dialog

(defn- button
  "The button whose text is exactly `text` (`tr` answers the key in tests)."
  [container text]
  (->> (js/Array.from (.querySelectorAll container "button"))
       (filter #(= text (str/trim (.-textContent %))))
       (first)))

(defn- by-id
  [container id]
  (.querySelector container (str "#" id)))

(defn- ^:async click!
  [element]
  (t/is (some? element))
  (when element
    (await (react/act #(.click element)))))

(defn- ^:async with-dialog
  "Mounts the dialog in a jsdom document and runs `(test-fn ctx)`, which
  returns a promise. The daemon is stubbed: `chat/run-workflow` and
  `chat/cancel-workflow` record their calls in `(:calls ctx)`,
  `chat/workflow-messages` answers a subject fed by `(:push! ctx)`, and
  `:on-apply` records what the dialog applies. `(:unmount! ctx)` closes
  the dialog. Resolves to the render errors React reported."
  [{:keys [connected props]} test-fn]
  (let [dom          (JSDOM. "<!doctype html><html><body><div id='root'></div></body></html>")
        window       (.-window dom)
        document     (.-document window)
        old-window   (.-window js/globalThis)
        old-document (.-document js/globalThis)
        old-act      (.-IS_REACT_ACT_ENVIRONMENT js/globalThis)
        errors       (volatile! [])
        on-error     (fn [error _info] (vswap! errors conj (.-message error)))
        container    (.getElementById document "root")
        calls        (atom {:runs [] :cancels [] :applied []})
        messages     (rx/subject)
        props        (assoc props :on-apply #(swap! calls update :applied conj %))]
    (set! (.-window js/globalThis) window)
    (set! (.-document js/globalThis) document)
    (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) true)
    (try
      (await
       ;; other test namespaces swap the store, so the connection ref
       ;; is replaced rather than read through `st/state`
       (mock/with-mocks* {globals/document document
                          globals/window window
                          ;; a store of its own: other namespaces leave
                          ;; `st/state` replaced
                          st/state (ptk/store {})
                          dialog/ref:connected (l/atom connected)
                          chat/run-workflow
                          (mock/stub (fn [name params opts]
                                       (swap! calls update :runs conj
                                              {:name name :params params :opts opts})
                                       (ptk/data-event ::run-workflow nil)))
                          chat/workflow-messages
                          (mock/stub (fn [_ _] messages))
                          chat/cancel-workflow
                          (mock/stub (fn [run-id]
                                       (swap! calls update :cancels conj run-id)
                                       (ptk/data-event ::cancel-workflow nil)))}
         (let [root      (rdc/createRoot container #js {:onUncaughtError on-error
                                                        :onCaughtError on-error
                                                        :onRecoverableError on-error})
               unmounted (volatile! false)
               unmount!  (^:async fn []
                           (when-not @unmounted
                             (vreset! unmounted true)
                             (await (react/act #(.unmount root)))))
               push!     (^:async fn [message]
                           (await (react/act #(rx/push! messages message))))]
           (try
             (await (react/act #(.render root (mf/element dialog/auto-name-dialog props))))
             (await (test-fn {:container container
                              :calls calls
                              :push! push!
                              :unmount! unmount!}))
             (finally
               (await (unmount!)))))))
      (finally
        (.close window)
        (set! (.-window js/globalThis) old-window)
        (set! (.-document js/globalThis) old-document)
        (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) old-act)))
    @errors))

(def ^:private renames
  [{:node-id "a" :page-id "p" :type "rect" :old-name "Rectangle 1" :new-name "Card" :ambiguous false}
   {:node-id "b" :page-id "p" :type "frame" :old-name "Board 2" :new-name "Home" :ambiguous false}
   {:node-id "t" :page-id "p" :type "text" :old-name "Text 3" :new-name "Price" :ambiguous true}])

(defn- ^:async finish-run!
  "Plays a successful daemon run that proposes `renames`."
  [push! renames]
  (await (push! {:type "workflow.started" :rid "r" :run-id "run-1" :name "auto-name"}))
  (await (push! {:type "workflow.event" :run-id "run-1" :kind "progress"
                 :payload {:stage "name" :done 1 :total 3}}))
  (await (push! {:type "workflow.event" :run-id "run-1" :kind "result"
                 :payload {:renames renames :candidates (count renames) :remaining 0}}))
  (await (push! {:type "workflow.done" :run-id "run-1" :ok true :summary "ok"})))

(t/deftest ^:async dialog-renders-the-setup-step
  (let [errors
        (await
         (with-dialog
           {:connected true
            :props {:scope :selection :node-ids ["a"] :page-id "p" :persona :developer}}
           (^:async fn [{:keys [container]}]
             (let [markup (.-innerHTML container)]
               (t/is (str/includes? markup "penforge-auto-name-scope-selection"))
               (t/is (str/includes? markup "penforge-auto-name-components"))
               ;; developers choose the naming style
               (t/is (str/includes? markup "penforge.auto-name.convention"))))))]
    (t/is (empty? errors))))

(t/deftest ^:async dialog-asks-to-connect-first
  (let [errors
        (await
         (with-dialog
           {:connected false
            :props {:scope :page :node-ids [] :page-id "p" :persona :designer}}
           (^:async fn [{:keys [container]}]
             (let [markup (.-innerHTML container)]
               (t/is (str/includes? markup "penforge.auto-name.not-connected"))
               (t/is (not (str/includes? markup "penforge-auto-name-scope-page")))))))]
    (t/is (empty? errors))))

(t/deftest ^:async dialog-sends-the-choices-and-applies-the-checked-names
  (let [errors
        (await
         (with-dialog
           {:connected true
            :props {:scope :selection :node-ids ["a"] :page-id "p" :persona :developer}}
           (^:async fn [{:keys [container calls push!]}]
             ;; choices made after the first render reach the workflow
             (await (click! (by-id container "penforge-auto-name-scope-file")))
             (await (click! (by-id container "penforge-auto-name-components")))
             (await (click! (button container "penforge.auto-name.preview")))
             (let [{:keys [name params opts]} (first (:runs @calls))]
               (t/is (= "auto-name" name))
               (t/is (= {:scope "file" :convention "title" :include-components true :page-id "p"}
                        params))
               (t/is (true? (:silent opts))))

             (await (finish-run! push! renames))
             (t/is (some? (by-id container "penforge-auto-name-a")))
             ;; leave "Board 2" out, apply the rest
             (await (click! (by-id container "penforge-auto-name-b")))
             (await (click! (button container "penforge.auto-name.apply")))
             (t/is (= [["a" "t"]]
                      (mapv #(mapv :node-id %) (:applied @calls))))
             (t/is (= ["Card" "Price"] (mapv :new-name (first (:applied @calls)))))
             (t/is (str/includes? (.-innerHTML container) "penforge.auto-name.done")))))]
    (t/is (empty? errors))))

(t/deftest ^:async rename-all-applies-plain-names-and-reviews-real-words
  (let [errors
        (await
         (with-dialog
           {:connected true
            :props {:scope :page :node-ids [] :page-id "p" :persona :designer}}
           (^:async fn [{:keys [container calls push!]}]
             (await (click! (button container "penforge.auto-name.apply-all")))
             (await (finish-run! push! renames))
             ;; plain default names are applied at once
             (t/is (= [["a" "b"]] (mapv #(mapv :node-id %) (:applied @calls))))
             ;; the layer named with a real word waits for review
             (t/is (some? (by-id container "penforge-auto-name-t")))
             (t/is (nil? (by-id container "penforge-auto-name-a")))
             (t/is (str/includes? (.-innerHTML container) "penforge.auto-name.review-ambiguous"))
             (await (click! (button container "penforge.auto-name.apply")))
             (t/is (= [["a" "b"] ["t"]] (mapv #(mapv :node-id %) (:applied @calls)))))))]
    (t/is (empty? errors))))

(t/deftest ^:async closing-the-dialog-stops-the-run
  (let [errors
        (await
         (with-dialog
           {:connected true
            :props {:scope :page :node-ids [] :page-id "p" :persona :developer}}
           (^:async fn [{:keys [container calls push! unmount!]}]
             (await (click! (button container "penforge.auto-name.preview")))
             (await (push! {:type "workflow.started" :rid "r" :run-id "run-1" :name "auto-name"}))
             (await (unmount!))
             (t/is (= ["run-1"] (:cancels @calls))))))]
    (t/is (empty? errors))))

(t/deftest ^:async closing-after-the-run-sends-no-cancel
  (let [errors
        (await
         (with-dialog
           {:connected true
            :props {:scope :page :node-ids [] :page-id "p" :persona :developer}}
           (^:async fn [{:keys [container calls push! unmount!]}]
             (await (click! (button container "penforge.auto-name.preview")))
             (await (finish-run! push! renames))
             (await (unmount!))
             (t/is (empty? (:cancels @calls))))))]
    (t/is (empty? errors))))
