;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-linked-test
  "Game UI and Existing projects (W38): project types, folder checks,
  daemon replies, the chat gate of the background read and the
  Re-Design flow."
  (:require
   [app.common.files.changes :as cpc]
   [app.common.schema :as sm]
   [app.common.types.file :as ctf]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.build]
   [app.main.data.ai.actions.redesign-code :as redesign]
   [app.main.data.ai.linked :as linked]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.penforge :as pf]
   [app.main.ui.dashboard.penforge.change-folder :as change-folder]
   [app.main.ui.dashboard.penforge.create-project :as create-project]
   [cljs.test :as t :include-macros true]))

(defn- json
  [data]
  (js/JSON.stringify (clj->js data)))

(def ^:private project-id (uuid/next))

(defn- workspace-state
  [platform & {:as extra}]
  (merge {:current-project-id project-id
          :penforge-project-settings {project-id platform}}
         extra))

;; --- Project types

(t/deftest platforms-include-the-linked-types
  (t/is (= #{:web :mobile :game :existing} pf/platforms))
  (t/is (pf/linked-platform? :game))
  (t/is (pf/linked-platform? :existing))
  (t/is (pf/linked-platform? "existing"))
  (t/is (not (pf/linked-platform? :web)))
  (t/is (not (pf/linked-platform? :mobile)))
  (t/is (not (pf/linked-platform? nil))))

(t/deftest design-platform-of-each-type
  (t/is (= :game (pf/design-platform :game nil)))
  (t/is (= :game (pf/design-platform :game "mobile")))
  (t/is (= :mobile (pf/design-platform :existing "mobile")))
  (t/is (= :web (pf/design-platform :existing "web")))
  (t/is (= :web (pf/design-platform :existing nil)) "unknown stack: web")
  (t/is (= :mobile (pf/design-platform :mobile nil)))
  (t/is (= :web (pf/design-platform :web "mobile")))
  (t/is (= :web (pf/design-platform nil nil))))

(t/deftest current-design-platform-reads-the-detected-stack
  (let [state (workspace-state :existing
                               :penforge {:linked {:projects {(str project-id)
                                                              {:linked true
                                                               :stack {:platform "mobile"}}}}})]
    (t/is (= :mobile (linked/current-design-platform state))))
  (let [state (workspace-state :existing
                               :penforge {:linked {:read {:result {:stack {:platform "mobile"}}}}})]
    (t/is (= :mobile (linked/current-design-platform state)) "falls back to the read result"))
  (t/is (= :game (linked/current-design-platform (workspace-state :game))))
  (t/is (= :web (linked/current-design-platform {}))))

(t/deftest game-files-start-with-one-full-hd-board
  (let [file-id (uuid/next)
        page-id (uuid/next)
        data    (ctf/make-file-data file-id page-id)
        changes (pf/platform-board-changes :game page-id)
        page    (-> (cpc/process-changes data changes)
                    (get-in [:pages-index page-id]))
        boards  (->> (vals (:objects page))
                     (filter #(= :frame (:type %)))
                     (remove #(= uuid/zero (:id %))))]
    (t/is (sm/validate cpc/schema:changes changes))
    (t/is (= [["Main Menu" 1920 1080]] (mapv (juxt :name :width :height) boards)))))

(t/deftest existing-files-start-empty
  (t/is (= [] (pf/platform-boards :existing)))
  (t/is (= [] (pf/platform-board-changes :existing (uuid/next)))))

;; --- Folder checks and the create button

(def ^:private unity-facts
  {:git true :unity true :unreal false :markers [] :empty false :engine "unity" :stack nil})

(def ^:private app-facts
  {:git true :unity false :unreal false :markers ["package.json"] :empty false
   :engine nil :stack {:platform "web" :name "react"}})

(t/deftest folder-problem-per-type
  (t/is (= :no-folder (linked/folder-problem :game nil)))
  (t/is (= :no-folder (linked/folder-problem :game {:path "" :facts unity-facts})))
  (t/is (= :no-folder (linked/folder-problem :game {:path "C:\\Games\\Quest" :facts nil})))
  (t/is (nil? (linked/folder-problem :game {:path "C:\\Games\\Quest" :facts unity-facts})))
  (t/is (nil? (linked/folder-problem :game {:path "/g" :facts (assoc unity-facts :engine "unreal")})))
  (t/is (= :not-a-game (linked/folder-problem :game {:path "/app" :facts app-facts})))
  (t/is (nil? (linked/folder-problem :existing {:path "/app" :facts app-facts})))
  (t/is (= :empty-folder (linked/folder-problem :existing {:path "/new" :facts (assoc app-facts :empty true)}))))

(t/deftest create-button-needs-a-fitting-folder-for-linked-types
  (let [game {:path "D:/Quest" :facts unity-facts}
        app  {:path "D:/shop" :facts app-facts}]
    (t/is (true? (create-project/can-create? "Shop" :web)) "web needs no folder")
    (t/is (false? (create-project/can-create? "Quest" :game)) "no folder yet")
    (t/is (true? (create-project/can-create? "Quest" :game game)))
    (t/is (false? (create-project/can-create? "Quest" :game app)) "not a game")
    (t/is (true? (create-project/can-create? "Shop" :existing app)))
    (t/is (false? (create-project/can-create? "Shop" :existing (assoc-in app [:facts :empty] true))))
    (t/is (false? (create-project/can-create? "" :existing app)))))

(t/deftest picked-folder-only-once-loaded
  (t/is (nil? (create-project/picked-folder {:status :loading :path "/a"})))
  (t/is (nil? (create-project/picked-folder {:status :loaded :path nil :roots []})))
  (t/is (= {:path "/a" :facts app-facts}
           (create-project/picked-folder {:status :loaded :path "/a" :facts app-facts}))))

;; --- Protocol

(t/deftest new-client-messages-are-valid
  (t/is (proto/valid-client-message? (proto/folder-list {})))
  (t/is (proto/valid-client-message? (proto/folder-list {:path "C:\\Users"})))
  (t/is (= "game" (:kind (proto/project-link {:project-id project-id :kind :game :path "/g"}))))
  (t/is (proto/valid-client-message? (proto/project-link {:project-id project-id :kind :existing :path "/a"})))
  (t/is (not (proto/valid-client-message? (proto/project-link {:project-id project-id :kind :web :path "/a"}))))
  (t/is (proto/valid-client-message? (proto/project-link-status {:project-id project-id})))
  (t/is (proto/valid-client-message? (proto/context-set {:file-id "f" :file-name "F" :project-id "p"
                                                         :team-id "t" :page-id "pg"
                                                         :persona :designer :platform :game}))))

(t/deftest daemon-replies-decode
  (let [listing (proto/decode (json {"type" "folder.list" "rid" "r1" "path" nil "parent" nil
                                     "roots" [{"name" "C:" "path" "C:\\" "kind" "drive"}]
                                     "entries" [] "truncated" false "facts" nil}))
        linked  (proto/decode (json {"type" "project.linked" "rid" "r2" "projectId" "p1"
                                     "linked" true "kind" "existing" "linkedRoot" "/a"
                                     "engine" nil "stack" {"platform" "web" "name" "react"}}))
        refused (proto/decode (json {"type" "error" "rid" "r3" "code" "bad-request"
                                     "reason" "not-a-game" "message" "Not a game"}))]
    (t/is (= "C:\\" (get-in listing [:roots 0 :path])))
    (t/is (= "/a" (:linked-root linked)))
    (t/is (= "web" (get-in linked [:stack :platform])))
    (t/is (= "not-a-game" (:reason refused)))))

;; --- Daemon replies in the state

(t/deftest folder-listing-fills-the-browser
  (let [state  {:penforge {:linked {:browser {:status :loading :rid "r1"}}}}
        state  (linked/apply-message state {:type "folder.list" :rid "r1" :path "/home/u"
                                            :parent "/home"
                                            :entries [{:name "game" :path "/home/u/game"}
                                                      {:name 3}]
                                            :truncated false
                                            :facts app-facts})
        browser (get-in state [:penforge :linked :browser])]
    (t/is (= :loaded (:status browser)))
    (t/is (= "/home/u" (:path browser)))
    (t/is (= [{:name "game" :path "/home/u/game"}] (:entries browser)) "malformed entries dropped")
    (t/is (= app-facts (:facts browser)))))

(t/deftest stale-listings-and-other-errors-are-ignored
  (let [state {:penforge {:linked {:browser {:status :loading :rid "new"}}}}]
    (t/is (= state (linked/apply-message state {:type "folder.list" :rid "old" :path "/x" :entries []})))
    (t/is (= state (linked/apply-message state {:type "error" :rid "other" :code "busy" :message "m"})))
    (t/is (= state (linked/apply-message state {:type "chat.delta"})))))

(t/deftest refused-folder-and-link
  (let [state {:penforge {:linked {:browser {:status :loading :rid "b"}
                                   :link {:status :pending :rid "l" :project-id "p1"}}}}
        state (-> state
                  (linked/apply-message {:type "error" :rid "b" :code "bad-request"
                                         :reason "folder-missing" :message "missing"})
                  (linked/apply-message {:type "error" :rid "l" :code "bad-request"
                                         :reason "not-a-game" :message "no"}))]
    (t/is (= :failed (get-in state [:penforge :linked :browser :status])))
    (t/is (= "folder-missing" (get-in state [:penforge :linked :browser :error :reason])))
    (t/is (= :failed (get-in state [:penforge :linked :link :status])))
    (t/is (= "not-a-game" (get-in state [:penforge :linked :link :error :reason])))))

(t/deftest project-linked-reply
  (let [state {:penforge {:linked {:link {:status :pending :rid "l" :project-id "p1"}}}}
        state (linked/apply-message state {:type "project.linked" :rid "l" :project-id "p1"
                                           :linked true :kind "game" :linked-root "D:/Quest"
                                           :engine "unity"})]
    (t/is (= :linked (get-in state [:penforge :linked :link :status])))
    (t/is (= "D:/Quest" (get-in state [:penforge :linked :projects "p1" :linked-root]))))
  (t/testing "a status reply of another request only records the project"
    (let [state (linked/apply-message {} {:type "project.linked" :rid "s" :project-id "p2"
                                          :linked false})]
      (t/is (false? (get-in state [:penforge :linked :projects "p2" :linked])))
      (t/is (nil? (get-in state [:penforge :linked :link]))))))

;; --- Background read and the chat gate

(def ^:private running
  {:status :running :rid "r" :project-id (str project-id)})

(t/deftest read-progress-and-result
  (let [read (-> running
                 (linked/apply-read-message {:type "workflow.started" :run-id "run1"})
                 (linked/apply-read-message {:type "workflow.event" :kind "progress"
                                             :payload {:step "inventory" :params {:done 3 :total 12}
                                                       :text "Listing"}}))]
    (t/is (= "run1" (:run-id read)))
    (t/is (= {:done 3 :total 12} (linked/read-progress read)))
    (t/is (= :running (:status read)))
    (let [done (-> read
                   (linked/apply-read-message {:type "workflow.event" :kind "result"
                                               :payload {:state "ready" :files 12}})
                   (linked/apply-read-message {:type "workflow.done" :ok true}))]
      (t/is (= :ready (:status done)))
      (t/is (= 12 (get-in done [:result :files]))))))

(t/deftest read-unchanged-not-linked-and-failures
  (t/is (= :ready (:status (linked/apply-read-message running {:type "workflow.event" :kind "result"
                                                               :payload {:state "unchanged"}}))))
  (t/is (= :ready (:status (linked/apply-read-message running {:type "workflow.done" :ok true})))
        "a run that ends well without a result counts as read")
  (let [not-linked (-> running
                       (linked/apply-read-message {:type "workflow.event" :kind "result"
                                                   :payload {:state "not-linked" :reason "missing"}})
                       (linked/apply-read-message {:type "workflow.done" :ok true}))]
    (t/is (= :not-linked (:status not-linked)) "done keeps the folder request"))
  (let [failed (linked/apply-read-message running {:type "workflow.done" :ok false :error "boom"})]
    (t/is (= :failed (:status failed)))
    (t/is (= "boom" (get-in failed [:error :message]))))
  (t/is (= :failed (:status (linked/apply-read-message running {:type "error" :code "unknown-workflow"
                                                                :message "no"})))))

(t/deftest chat-gate-per-type-and-read-state
  (t/is (false? (linked/gate-locked? :web nil project-id)) "web projects never wait")
  (t/is (false? (linked/gate-locked? :mobile running project-id)))
  (t/is (true? (linked/gate-locked? :game nil project-id)) "read not started yet")
  (t/is (true? (linked/gate-locked? :game running project-id)))
  (t/is (true? (linked/gate-locked? :existing (assoc running :status :not-linked) project-id)))
  (t/is (false? (linked/gate-locked? :existing (assoc running :status :ready) project-id)))
  (t/is (false? (linked/gate-locked? :game (assoc running :status :failed) project-id))
        "a failed read opens the chat with a notice")
  (t/is (true? (linked/gate-locked? :game (assoc running :status :ready) (uuid/next)))
        "a read of another project does not count")
  (t/is (true? (linked/chat-locked? (workspace-state :game :penforge {:linked {:read running}}))))
  (t/is (false? (linked/chat-locked? (workspace-state :game :penforge {:linked {:read (assoc running :status :ready)}}))))
  (t/is (true? (linked/read-done? (workspace-state :game :penforge {:linked {:read (assoc running :status :ready)}})))))

;; --- Re-Design

(t/deftest redesign-workflow-per-type
  (t/is (= "game-ui-export" (redesign/workflow-for :game)))
  (t/is (= "code-redesign" (redesign/workflow-for :existing)))
  (t/is (= "code-redesign" (redesign/workflow-for "existing")))
  (t/is (nil? (redesign/workflow-for :web)))
  (t/is (nil? (redesign/workflow-for :mobile))))

(def ^:private run-result
  {:action "run" :branch "penforge/redesign-20261121-1030" :base-branch "main"
   :files-changed ["src/App.css" "src/Card.tsx" "src/api.ts"]
   :screens [{:name "Home" :status "done"} {:name "Cart" :status "partial"}
             {:name "Login" :status "skipped"}]
   :unmatched ["Cart badge animation"]
   :outside-look [{:path "src/api.ts" :reason "logic" :detail "new API call"}]})

(t/deftest redesign-plan-run-revert
  (let [planning {:status :planning :workflow "code-redesign" :rid "r"}
        confirm  (redesign/apply-redesign-message
                  planning {:type "workflow.event" :kind "result"
                            :payload {:action "plan" :git true :dirty false :branch "penforge/redesign-x"
                                      :screens [{:board-id "b1" :name "Home"}]}})
        done     (redesign/apply-redesign-message
                  (assoc confirm :status :running)
                  {:type "workflow.event" :kind "result" :payload run-result})
        reverted (redesign/apply-redesign-message
                  (assoc done :status :reverting)
                  {:type "workflow.event" :kind "result"
                   :payload {:action "revert" :reverted ["src/api.ts"] :commit "abc"}})]
    (t/is (= :confirm (:status confirm)))
    (t/is (= "penforge/redesign-x" (get-in confirm [:plan :branch])))
    (t/is (= :done (:status done)))
    (t/is (= 1 (count (get-in done [:result :outside-look]))))
    (t/is (= :done (:status reverted)))
    (t/is (empty? (get-in reverted [:result :outside-look])))
    (t/is (= ["src/api.ts"] (:reverted reverted)))))

(t/deftest redesign-cancel-and-failures
  (t/is (= :cancelled (:status (redesign/apply-redesign-message
                                {:status :running}
                                {:type "workflow.event" :kind "result"
                                 :payload {:action "run" :cancelled true}}))))
  (t/is (= :failed (:status (redesign/apply-redesign-message
                             {:status :running} {:type "workflow.done" :ok false :error "git failed"}))))
  (t/is (= :failed (:status (redesign/apply-redesign-message
                             {:status :planning} {:type "workflow.done" :ok true :summary "no plan"})))
        "a plan step must answer a plan")
  (t/is (= :failed (:status (redesign/apply-redesign-message
                             {:status :planning} {:type "error" :code "unknown-workflow" :message "no"}))))
  (t/is (= :done (:status (redesign/apply-redesign-message
                           {:status :confirm} {:type "workflow.event" :kind "result"
                                               :payload {:action "run"}}))))
  (t/is (true? (redesign/running? {:status :reverting})))
  (t/is (false? (redesign/running? {:status :confirm}))))

(t/deftest redesign-summary-card-data
  (let [existing (redesign/summary-data "code-redesign" run-result)
        game     (redesign/summary-data "game-ui-export"
                                        {:action "run" :folder "D:/Quest/PenforgeUI" :assets 7
                                         :screens [{:name "HUD" :slug "hud" :guide "guides/hud.md"}
                                                   {:name "Pause" :slug "pause" :guide "guides/pause.md"}]})]
    (t/is (= {:kind :existing :branch "penforge/redesign-20261121-1030" :files 3
              :screens-done 1 :screens-partial 1 :unmatched ["Cart badge animation"]
              :outside [{:path "src/api.ts" :reason "logic" :detail "new API call"}]}
             existing))
    (t/is (= {:kind :game :folder "D:/Quest/PenforgeUI" :branch nil :screens 2 :pngs 4
              :guides 2 :assets 7}
             game))))

;; --- Actions per project type

(defn- action-visible?
  [id state]
  (let [{:keys [visible?]} (get @actions/registry id)]
    (boolean (if visible? (visible? state) true))))

(t/deftest redesign-replaces-build-for-linked-types
  (doseq [platform [:game :existing]]
    (let [state (workspace-state platform)]
      (t/is (action-visible? :ai/redesign-code state) (str platform))
      (t/is (action-visible? :ai/read-project state) (str platform))
      (t/is (not (action-visible? :ai/build state)) (str platform))))
  (doseq [platform [:web :mobile nil]]
    (let [state (workspace-state platform)]
      (t/is (not (action-visible? :ai/redesign-code state)) (str platform))
      (t/is (not (action-visible? :ai/read-project state)) (str platform))
      (t/is (action-visible? :ai/build state) (str platform)))))

(t/deftest redesign-waits-for-the-read
  (let [action (get @actions/registry :ai/redesign-code)
        ready  (workspace-state :game :penforge {:linked {:read (assoc running :status :ready)}})]
    (t/is (= #{:island :main-menu :command-palette} (:scopes action)))
    (t/is (true? (:primary action)))
    (t/is (false? (actions/enabled? action (workspace-state :game :penforge {:linked {:read running}}))))
    (t/is (true? (actions/enabled? action ready)))
    (t/is (false? (actions/enabled? action (assoc-in ready [:penforge :linked :redesign]
                                                     {:status :running}))))))

;; --- Change folder (project menu)

(t/deftest change-folder-is-offered-for-linked-projects-only
  (let [game     (uuid/next)
        existing (uuid/next)
        web      (uuid/next)
        settings {game :game existing :existing web :web}]
    (with-redefs [cf/flags (conj cf/flags :ai)]
      (t/is (change-folder/visible? settings {:id game}))
      (t/is (change-folder/visible? settings {:id existing}))
      (t/is (not (change-folder/visible? settings {:id web})))
      (t/is (not (change-folder/visible? settings {:id (uuid/next)})) "platform not loaded yet")
      (t/is (not (change-folder/visible? settings {}))))
    (with-redefs [cf/flags (disj cf/flags :ai)]
      (t/is (not (change-folder/visible? settings {:id game}))))))

(t/deftest change-folder-needs-another-fitting-folder
  (let [app-folder  {:path "F:/adissio/apps/landing" :facts {:empty false :markers ["package.json"]}}
        game-folder {:path "D:/games/hero" :facts {:engine "unity"}}]
    (t/is (change-folder/can-change? :existing app-folder "F:/adissio/apps/admin"))
    (t/is (not (change-folder/can-change? :existing app-folder "F:/adissio/apps/landing"))
          "the folder it already uses")
    (t/is (not (change-folder/can-change? :existing nil "F:/adissio")) "nothing picked yet")
    (t/is (not (change-folder/can-change? :game app-folder nil)) "not a game folder")
    (t/is (change-folder/can-change? :game game-folder nil) "the current folder is unknown")))
