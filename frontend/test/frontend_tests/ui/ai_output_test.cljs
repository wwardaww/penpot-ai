;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-output-test
  "Build dropdown and output folder (W41): the split button, the folder
  that Build and Instruct ask for, the Instruct state, and a render of
  the new dialogs (jsdom documents, the runner has no DOM)."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom" :as rd]
   ["react-dom/client" :as rdc]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.build]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.design-system :as design-system]
   [app.main.data.ai.protocol :as proto]
   [app.main.ui.dashboard.penforge.change-folder :as change-folder]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.main.ui.workspace.ai.build.instruct :as instruct]
   [app.main.ui.workspace.ai.build.instruct-dialog :as instruct-dialog]
   [app.main.ui.workspace.ai.build.output :as output]
   [app.main.ui.workspace.ai.build.output-dialog :as output-dialog]
   [app.main.ui.workspace.ai.header-strip :as header-strip]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def ^:private project-id
  #uuid "a3de49e3-507f-8040-8008-fb2d0ea52a89")

(defn- status
  "A `project.output` reply."
  [app-state output-state]
  {:type "project.output"
   :rid "r"
   :project-id (str project-id)
   :app {:state app-state
         :path (when (not= "none" app-state) "F:/apps/shop")
         :built (= "internal" app-state)}
   :output {:state output-state
            :path (when (not= "none" output-state) "F:/apps/shop")}})

(defn- connected-state
  [& {:as more}]
  (merge {:current-project-id project-id
          :projects {project-id {:id project-id :name "Shop"}}
          :penforge {:connection {:status :connected}}}
         more))

(defn- emitted
  "Events `event` emits from its watch when the daemon answers every
  message it sends with `(answer message)`."
  [event state answer]
  (let [events (atom [])
        stream (rx/subject)
        sent   (atom [])]
    (with-redefs [client/send! (mock/stub
                                (fn [message]
                                  (swap! sent conj message)
                                  (rx/push! stream (ptk/data-event ::client/message
                                                                   (assoc (answer message)
                                                                          :rid (:rid message))))
                                  true))]
      (rx/sub! (ptk/watch event state stream)
               #(swap! events conj %)))
    {:events @events
     :types (mapv ptk/type @events)
     :sent @sent}))

(defn- modal-of
  "`[type props]` of the modal a show event opens."
  [event]
  (let [modal (:app.main.data.modal/modal (ptk/update event {}))]
    [(:type modal) (:props modal)]))

;; --- Split button

(t/deftest instruct-belongs-to-the-build-button
  (let [action (get @actions/registry :ai/instruct)]
    (t/is (= :ai/build (:split-of action)))
    (t/is (= #{:island :main-menu :command-palette} (:scopes action)))
    (t/is (not (:primary action)))
    (t/is (= "penforge.instruct.action" (actions/get-label action)))
    (t/testing "offered for web and mobile, not for Game UI and Existing projects"
      (doseq [[platform visible] [[:web true] [:mobile true] [nil true] [:game false] [:existing false]]]
        (t/is (= visible
                 (boolean ((:visible? action)
                           {:current-project-id project-id
                            :penforge-project-settings {project-id platform}})))
              (str platform))))
    (t/testing "waits for a running build"
      (t/is (actions/enabled? action {}))
      (t/is (not (actions/enabled? action {:penforge {:build {:stage :building}}}))))
    (t/testing "a design system file hides it like Build"
      (t/is (contains? design-system/hidden-actions :ai/instruct)))))

(t/deftest the-toolbar-groups-a-button-with-its-dropdown
  (let [registry {:ai/build {:id :ai/build :label (constantly "Build") :primary true
                             :order 90 :scopes #{:island} :run identity}
                  :ai/instruct {:id :ai/instruct :label (constantly "Instruct") :split-of :ai/build
                                :order 91 :scopes #{:island} :run identity}
                  :ai/other {:id :ai/other :label (constantly "Other") :primary true
                             :order 95 :scopes #{:island} :run identity}}
        items    (header-strip/scope-items registry :island {})
        [build-button other-button :as buttons] (header-strip/split-items items)]
    (t/is (= 2 (count buttons)) "Instruct is no button of its own")
    (t/is (= "Build" (get-in build-button [:item :label])))
    (t/is (= ["Build" "Instruct"] (mapv :label (:menu build-button))))
    (t/is (= "Other" (get-in other-button [:item :label])))
    (t/is (nil? (:menu other-button)))
    (t/is (= [] (header-strip/split-items
                 (header-strip/scope-items (dissoc registry :ai/build :ai/other) :island {})))
          "without Build there is no dropdown")))

;; --- Protocol

(t/deftest the-protocol-knows-the-output-folder
  (let [pick {:project-id project-id :purpose :instruct :path "F:/apps" :name "Shop"}]
    (t/is (proto/valid-client-message? (proto/project-output-status {:project-id project-id})))
    (t/is (proto/valid-client-message? (proto/project-output-preview pick)))
    (t/is (proto/valid-client-message? (proto/project-output-set (dissoc pick :name))))
    (t/is (= {:type "project.output.set" :rid "r1" :project-id (str project-id)
              :purpose "instruct" :path "F:/apps" :name "Shop"}
             (proto/project-output-set (assoc pick :rid "r1")))))
  (let [message (proto/decode
                 (str "{\"type\":\"project.output\",\"rid\":\"r\",\"projectId\":\"p\","
                      "\"app\":{\"state\":\"none\",\"path\":null,\"built\":false},"
                      "\"output\":{\"state\":\"none\",\"path\":null},"
                      "\"target\":{\"picked\":\"F:/a\",\"path\":\"F:/a/shop\",\"subFolder\":true,"
                      "\"existing\":false}}"))]
    (t/is (= "none" (get-in message [:app :state])))
    (t/is (true? (get-in message [:target :sub-folder])))))

;; --- Asking for a folder

(t/deftest a-folder-is-asked-for-once
  (t/testing "Build"
    (t/is (output/needs-folder? :build nil))
    (t/is (output/needs-folder? :build (status "none" "none")))
    (t/is (output/needs-folder? :build (status "missing" "missing")) "gone: ask again")
    (t/is (output/needs-folder? :build (status "none" "ready")) "picked by Instruct only")
    (t/is (not (output/needs-folder? :build (status "ready" "ready"))))
    (t/is (not (output/needs-folder? :build (status "internal" "none"))) "built before W41"))
  (t/testing "Instruct"
    (t/is (output/needs-folder? :instruct (status "none" "none")))
    (t/is (output/needs-folder? :instruct (status "internal" "none")))
    (t/is (output/needs-folder? :instruct (status "ready" "missing")))
    (t/is (not (output/needs-folder? :instruct (status "none" "ready")))))
  (t/testing "the dialog starts at the known folder"
    (t/is (= "F:/apps/shop" (output/get-start-path (status "none" "ready"))))
    (t/is (nil? (output/get-start-path (status "missing" "missing")))))
  (t/testing "Change folder moves the app once there is one"
    (t/is (= :instruct (output/get-purpose nil)))
    (t/is (= :instruct (output/get-purpose (status "none" "ready"))))
    (t/is (= :build (output/get-purpose (status "internal" "none"))))
    (t/is (= :build (output/get-purpose (status "ready" "ready"))))))

(t/deftest build-asks-for-a-folder-before-it-plans
  (let [ensure (output/ensure-folder :build build/start-plan build/start-plan)]
    (t/testing "no folder: the dialog opens and nothing is planned"
      (let [{:keys [types events sent]} (emitted ensure (connected-state) (fn [_] (status "none" "none")))]
        (t/is (= ["project.output.status"] (mapv :type sent)))
        (t/is (= [::output/output-received ::output/change-folder] types))
        (let [[show]       (:events (emitted (second events) (connected-state) (constantly nil)))
              [type props] (modal-of show)]
          (t/is (= output/modal-type type))
          (t/is (= :build (:purpose props)))
          (t/is (= project-id (:project-id props)))
          (t/is (= "Shop" (:project-name props)))
          (t/is (= ::build/start-plan (ptk/type ((:on-done props))))))))
    (t/testing "a known folder or an app from before W41 goes on"
      (doseq [app-state ["ready" "internal"]]
        (t/is (= [::output/output-received ::build/start-plan]
                 (:types (emitted ensure (connected-state) (fn [_] (status app-state "none"))))))))
    (t/testing "a daemon without output folders goes on as before"
      (doseq [code ["not-configured" "not-implemented" "bad-request"]]
        (t/is (= [::build/start-plan]
                 (:types (emitted ensure (connected-state)
                                  (fn [_] {:type "error" :code code :message "no"})))))))
    (t/testing "another failure plans nothing"
      (let [{:keys [types]} (emitted ensure (connected-state)
                                     (fn [_] {:type "error" :code "internal" :message "disk"}))]
        (t/is (not-any? #{::build/start-plan} types))
        (t/is (= 1 (count types)))))
    (t/testing "without a connection the dialog says so"
      (let [{:keys [types sent]} (emitted ensure {:current-project-id project-id} (constantly nil))]
        (t/is (= [::build/start-plan] types))
        (t/is (empty? sent))))))

(t/deftest build-and-update-go-through-the-folder
  (t/is (= [::output/ensure-folder] (:types (emitted (build/start) (connected-state) (constantly nil)))))
  (t/is (= [::output/ensure-folder] (:types (emitted (build/start-update) (connected-state) (constantly nil)))))
  (t/testing "a running build only shows the dialog"
    (let [state (assoc-in (connected-state) [:penforge :build] {:stage :building})]
      (doseq [event [(build/start) (build/start-update)]]
        (let [{:keys [events]} (emitted event state (constantly nil))]
          (t/is (= [build/modal-type {}] (modal-of (first events)))))))))

(t/deftest changing-the-folder-from-the-build-dialog
  (let [after (fn [build-state]
                (:events (emitted (build/folder-changed)
                                  (assoc-in (connected-state) [:penforge :build] build-state)
                                  (constantly nil))))]
    (t/testing "a first plan stays"
      (t/is (= [build/modal-type {}]
               (modal-of (first (after {:stage :plan :plan {:mode "full"}}))))))
    (t/testing "an update plans again"
      (t/is (= [::build/start-plan] (mapv ptk/type (after {:stage :review}))))
      (t/is (= [::build/start-plan] (mapv ptk/type (after {:stage :plan :plan {:mode "incremental"}})))))))

(t/deftest change-folder-of-the-project-menu
  (let [project {:id project-id :name "Shop"}]
    (t/is (= [:penforge-change-folder {:project project}] (change-folder/get-modal :existing project)))
    (t/is (= [:penforge-change-folder {:project project}] (change-folder/get-modal :game project)))
    (let [[type props] (change-folder/get-modal :web project)]
      (t/is (= output/modal-type type))
      (t/is (= project-id (:project-id props)))
      (t/is (true? (:dashboard props)))
      (t/is (nil? (:purpose props)) "decided by what the project has"))))

;; --- Folder dialog state

(def ^:private target
  {:picked "F:/apps" :path "F:/apps/shop" :sub-folder true :existing false})

(t/deftest only-the-checked-folder-can-be-used
  (let [checking {:status :checking :rid "r1" :path "F:/apps"}
        ready    (output/apply-check checking "r1" (assoc (status "none" "none") :target target))]
    (t/is (= target (:target ready)))
    (t/is (output/can-use? ready "F:/apps"))
    (t/is (not (output/can-use? ready "F:/other")) "another folder is shown by now")
    (t/is (not (output/can-use? ready nil)))
    (t/is (not (output/can-use? checking "F:/apps")))
    (t/is (= checking (output/apply-check checking "old" {:type "error" :code "bad-request"}))
          "a late answer changes nothing")
    (let [failed (output/apply-check checking "r1" {:type "error" :code "bad-request" :reason "inside-git"
                                                    :message "no"})]
      (t/is (= :failed (:status failed)))
      (t/is (= "inside-git" (get-in failed [:error :reason])))
      (t/is (not (output/can-use? failed "F:/apps"))))))

(t/deftest using-a-folder-closes-the-dialog-and-goes-on
  (let [params {:project-id project-id :project-name "Shop" :purpose :build :on-done build/start-plan}
        {:keys [types sent]} (emitted (output/set-folder params "F:/apps") (connected-state)
                                      (fn [_] (status "ready" "ready")))]
    (t/is (= [["project.output.set" "build" "F:/apps" "Shop"]]
             (mapv (juxt :type :purpose :path :name) sent)))
    (t/is (= [::output/output-received :app.main.data.modal/hide-modal ::build/start-plan] types)))
  (t/testing "a refused folder starts nothing"
    (let [params {:project-id project-id :purpose :build :on-done build/start-plan}
          {:keys [types]} (emitted (output/set-folder params "F:/apps") (connected-state)
                                   (fn [_] {:type "error" :code "bad-request" :reason "folder-taken"}))]
      (t/is (= [::output/picker-updated] types))))
  (t/testing "closing the dialog starts nothing"
    (t/is (= [:app.main.data.modal/hide-modal]
             (:types (emitted (output/cancel-picker {:on-done build/start-plan}) (connected-state)
                              (constantly nil)))))))

(t/deftest the-reply-is-kept-per-project
  (let [state (ptk/update (output/output-received (status "ready" "ready")) {})]
    (t/is (= "ready" (get-in (output/get-output state project-id) [:app :state])))
    (t/is (= "F:/apps/shop" (output/get-path :build (output/get-output state project-id))))
    (t/is (nil? (output/get-output state (uuid/next))))))

;; --- Instruct state

(def ^:private plan-payload
  {:action "plan" :folder "F:/apps/shop/PenforgeUI"
   :screens [{:board-id "b1" :name "Home" :width 1440 :height 1024}
             {:board-id "b2" :name "Cart" :width 390 :height 844}]})

(def ^:private run-payload
  {:action "run" :folder "F:/apps/shop/PenforgeUI" :assets 7 :kept ["guides/cart.md"]
   :screens [{:name "Home" :slug "home" :captured true}
             {:name "Cart" :slug "cart" :captured false}]})

(defn- event
  [kind payload]
  {:type "workflow.event" :kind kind :payload payload})

(t/deftest instruct-run-states
  (let [planned (reduce instruct/apply-message {:stage :planning}
                        [{:type "workflow.started" :run-id "x"}
                         (event "result" plan-payload)
                         {:type "workflow.done" :ok true}])
        running (instruct/apply-message (assoc planned :stage :running)
                                        (event "progress" {:step "guides" :params {:done 1 :total 2}}))
        busy    (instruct/apply-message running (event "progress" {:summary "Looking at the design"}))
        done    (reduce instruct/apply-message running
                        [(event "result" run-payload) {:type "workflow.done" :ok true}])]
    (t/is (= :confirm (:stage planned)))
    (t/is (= plan-payload (:plan planned)))
    (t/is (= "guides" (get-in running [:progress :step])))
    (t/is (= running busy) "Claude's tool activity is no step")
    (t/is (= :done (:stage done)))
    (t/is (= run-payload (:result done)))
    (t/is (nil? (:progress done)))
    (t/is (instruct/running? running))
    (t/is (not (instruct/running? planned))))
  (t/testing "refusals keep their code"
    (let [refused (reduce instruct/apply-message {:stage :running}
                          [(event "result" {:action "run" :error "folder-taken" :message "no"})
                           {:type "workflow.done" :ok false :error "no"}])]
      (t/is (= :error (:stage refused)))
      (t/is (= "folder-taken" (:failure-code refused)))
      (t/is (= "penforge.instruct.error.folder" (instruct-dialog/get-error-text refused)))))
  (t/testing "an old daemon"
    (t/is (= :error (:stage (instruct/apply-message {:stage :planning}
                                                    {:type "error" :code "unknown-workflow"}))))))

(t/deftest instruct-asks-for-a-folder-first
  (t/is (= [::output/ensure-folder] (:types (emitted (instruct/start) (connected-state) (constantly nil)))))
  (let [state (assoc-in (connected-state) [:penforge :instruct] {:stage :running})
        {:keys [events]} (emitted (instruct/start) state (constantly nil))]
    (t/is (= [instruct/modal-type {}] (modal-of (first events))) "a running export is shown"))
  (t/is (= [::instruct/stop ::instruct/run :app.main.data.modal/show-modal]
           (:types (emitted (instruct/start-plan) (connected-state) (constantly nil)))))
  (t/is (empty? (:types (emitted (instruct/confirm) (connected-state) (constantly nil))))
        "nothing runs without a plan"))

;; --- Render

(defn- next-immediate
  []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- ^:async render
  "Renders a component once; resolves to `{:markup :errors}`."
  [component props]
  (let [errors    (volatile! [])
        on-error  (fn [error _info] (vswap! errors conj (.-message error)))
        window    (.-window (JSDOM. "<!doctype html><div id=\"root\"></div>"))
        container (.getElementById (.-document window) "root")
        root      (rdc/createRoot container #js {:onUncaughtError on-error
                                                 :onCaughtError on-error
                                                 :onRecoverableError on-error})
        previous  (.-window js/globalThis)
        markup    (volatile! nil)]
    (set! (.-window js/globalThis) window)
    (try
      (try
        (rd/flushSync
         (fn []
           (.render root (mf/element component props))))
        (vreset! markup (.-innerHTML container))
        (finally
          (rd/flushSync #(.unmount root))
          (.close window)))
      (await (next-immediate))
      (finally
        (set! (.-window js/globalThis) previous)))
    {:markup @markup :errors @errors}))

(def ^:private browser-state
  {:status :loaded :path "F:/apps" :parent "F:/" :entries [] :facts {:empty false}})

(defn- render-picker
  [purpose folder picker]
  (render output-dialog/picker-view*
          #js {:purpose purpose :folder folder :browser browser-state :picker picker
               :desktop false :onOpen identity :onChoose identity
               :onConfirm identity :onCancel identity}))

(t/deftest ^:async the-folder-dialog-shows-the-folder-before-the-start
  (let [sub-folder (await (render-picker :build nil
                                         {:status :ready :path "F:/apps" :target target}))
        instruct   (await (render-picker :instruct (status "internal" "none")
                                         {:status :ready :path "F:/apps"
                                          :target (assoc target :sub-folder false)}))
        moves      (await (render-picker :build (status "ready" "ready")
                                         {:status :ready :path "F:/apps"
                                          :target (assoc target :path "F:/apps/new")}))
        refused    (await (render-picker :build (status "missing" "missing")
                                         {:status :failed :path "F:/apps"
                                          :error {:code "bad-request" :reason "inside-git"}}))]
    (t/is (every? (comp empty? :errors) [sub-folder instruct moves refused]))
    (t/is (str/includes? (:markup sub-folder) "penforge.output.target.build"))
    (t/is (str/includes? (:markup sub-folder) "penforge.output.target.sub-folder"))
    (t/is (not (str/includes? (:markup sub-folder) "penforge.output.target.moves")))
    (t/is (str/includes? (:markup instruct) "penforge.output.target.instruct"))
    (t/is (str/includes? (:markup instruct) "penforge.output.target.empty"))
    (t/is (not (str/includes? (:markup instruct) "penforge.output.target.moves"))
          "Instruct moves no app")
    (t/is (str/includes? (:markup moves) "penforge.output.target.moves")
          "an app that stays behind is said")
    (t/is (str/includes? (:markup refused) "penforge.output.error.inside-git"))
    (t/is (str/includes? (:markup refused) "penforge.output.missing"))
    (t/is (not (str/includes? (:markup refused) "penforge-output-target")))))

(t/deftest ^:async the-folder-line-has-a-change-link
  (let [known   (await (render output-dialog/folder-line*
                               #js {:purpose :build :path "F:/apps/shop" :onChange identity}))
        unknown (await (render output-dialog/folder-line* #js {:purpose :build :path nil}))]
    (t/is (every? (comp empty? :errors) [known unknown]))
    (t/is (str/includes? (:markup known) "F:/apps/shop"))
    (t/is (str/includes? (:markup known) "penforge.output.change"))
    (t/is (= "" (:markup unknown)) "nothing while the folder is not known")))

(defn- render-instruct
  [state]
  (render instruct-dialog/instruct-view* #js {:instruct state}))

(t/deftest ^:async the-instruct-dialog-renders-its-stages
  (let [planning (await (render-instruct {:stage :planning}))
        confirm  (await (render-instruct {:stage :confirm :plan plan-payload}))
        running  (await (render-instruct {:stage :running :progress {:step "write"}}))
        done     (await (render-instruct {:stage :done :result run-payload}))
        offline  (await (render-instruct {:stage :error :error "not-connected"}))
        failed   (await (render-instruct {:stage :error :failure-code "no-screens"}))
        shows?   (fn [{:keys [markup]} & texts]
                   (every? #(str/includes? markup %) texts))]
    (t/is (every? (comp empty? :errors) [planning confirm running done offline failed]))
    (t/is (shows? planning "penforge.instruct.planning"))
    (t/is (shows? confirm "penforge.instruct.intro" "penforge.instruct.screens" "penforge.instruct.confirm"))
    (t/is (shows? running "penforge.instruct.running" "penforge.instruct.step.write"))
    (t/is (shows? done "penforge.instruct.done.summary" "F:/apps/shop/PenforgeUI"
                  "penforge.instruct.done.missing" "penforge.instruct.done.kept"))
    (t/is (shows? offline "penforge.build.error.not-connected" "penforge.build.error.open-ai"))
    (t/is (shows? failed "penforge.instruct.error.no-screens" "penforge.build.error.retry"))))

(t/deftest ^:async the-split-button-has-a-menu-toggle
  (let [item {:action {:id :ai/build} :enabled false :label "Up to date"}
        menu [item {:action {:id :ai/instruct} :enabled true :label "Instruct"}]
        {:keys [markup errors]} (await (render header-strip/split-action* #js {:item item :menu menu}))]
    (t/is (empty? errors))
    (t/is (str/includes? markup "Up to date"))
    (t/is (str/includes? markup "aria-haspopup=\"menu\""))
    (t/is (str/includes? markup "aria-expanded=\"false\""))
    (t/is (str/includes? markup "aria-label=\"penforge.build.menu\""))
    (t/is (not (str/includes? markup "role=\"menu\"")) "closed until asked for")))
