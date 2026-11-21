;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.linked
  "Linked project folders (W38): Game UI and Existing project designs
  work on a folder of the user's machine, which the Penforge daemon
  keeps per project (`.penforge/project.json` `linkedRoot`).

  - Folder browser: the browser cannot give a folder's real path, so
    the daemon lists folders (`folder.list`); in the desktop app the
    native dialog (`window.penforgeDesktopBridge.chooseFolder`) picks
    the path and `folder.list` reads its facts.
  - Link: `project.link` stores the folder for a project;
    `project.link.status` reads it back (`project.linked`).
  - Background read: when the workspace of a linked project opens, the
    `project-read` workflow reads the folder; the chat waits for it
    (`chat-locked?`).

  State lives under `[:penforge :linked]`:
  `{:browser {:status :loading|:loaded|:failed, :rid, :requested, :path,
  :parent, :roots, :entries, :truncated, :facts, :error},
  :link {:status :pending|:linked|:failed, :rid, :project-id, :error},
  :projects {<project id string> {:linked :kind :linked-root :engine
  :stack}},
  :read {:status :running|:ready|:failed|:not-linked, :rid, :run-id,
  :project-id, :progress, :result, :error}}`. Errors are
  `{:code :reason :message}` as the daemon sends them."
  (:require
   [app.common.logging :as log]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

(def engines
  "Engines a Game UI folder must use (daemon `FolderFacts.engine`)."
  #{"unity" "unreal"})

;; --- Pure helpers

(defn- state-path
  [& ks]
  (into [:penforge :linked] ks))

(defn folder-problem
  "Why `folder` (`{:path :facts}`, the folder the browser shows) cannot
  be linked to a project of `platform`: `:no-folder`, `:not-a-game` or
  `:empty-folder`; nil when it can."
  [platform {:keys [path facts]}]
  (let [platform (some-> platform keyword)]
    (cond
      (not (and (string? path) (seq path)))
      :no-folder

      (not (map? facts))
      :no-folder

      (and (= platform :game) (not (contains? engines (:engine facts))))
      :not-a-game

      (and (= platform :existing) (true? (:empty facts)))
      :empty-folder

      :else
      nil)))

(defn- folder-entry?
  [entry]
  (and (map? entry) (string? (:name entry)) (string? (:path entry))))

(defn apply-message
  "Apply a daemon message to the state; messages that are not about the
  folder browser or linked folders leave it unchanged."
  [state {:keys [type rid] :as msg}]
  (case type
    "folder.list"
    (if (and (some? rid) (= rid (get-in state (state-path :browser :rid))))
      (update-in state (state-path :browser) merge
                 {:status :loaded
                  :error nil
                  :path (:path msg)
                  :parent (:parent msg)
                  :roots (filterv folder-entry? (:roots msg))
                  :entries (filterv folder-entry? (:entries msg))
                  :truncated (true? (:truncated msg))
                  :facts (when (map? (:facts msg)) (:facts msg))})
      state)

    "project.linked"
    (let [state (assoc-in state (state-path :projects (:project-id msg))
                          (select-keys msg [:linked :kind :linked-root :engine :stack]))]
      (if (and (some? rid) (= rid (get-in state (state-path :link :rid))))
        (update-in state (state-path :link) merge
                   (if (:linked msg)
                     {:status :linked :error nil}
                     {:status :failed :error {:code "not-linked"}}))
        state))

    "error"
    (let [error (select-keys msg [:code :reason :message])]
      (cond
        (nil? rid)
        state

        (= rid (get-in state (state-path :browser :rid)))
        (update-in state (state-path :browser) merge {:status :failed :error error})

        (= rid (get-in state (state-path :link :rid)))
        (update-in state (state-path :link) merge {:status :failed :error error})

        :else
        state))

    state))

(defn apply-read-message
  "The read state (`:read`) after a message of its `project-read` run."
  [read {:keys [type kind payload ok error code message] :as msg}]
  (case type
    "workflow.started"
    (assoc read :run-id (:run-id msg))

    "workflow.event"
    (case kind
      "progress"
      (assoc read :progress (select-keys payload [:step :params :text]))

      "result"
      (case (:state payload)
        "not-linked"           (assoc read :status :not-linked :result payload)
        ("ready" "unchanged")  (assoc read :status :ready :result payload)
        read)

      read)

    "workflow.done"
    (if ok
      (cond-> read
        (= :running (:status read)) (assoc :status :ready))
      (assoc read :status :failed :error {:message (or error (:summary msg))}))

    "error"
    (assoc read :status :failed :error {:code code :message message})

    read))

(defn gate-locked?
  "True while the chat of a project of `platform` must wait: a linked
  project whose read of `project-id` has not ended (or needs the folder
  again)."
  [platform read project-id]
  (and (pf/linked-platform? platform)
       (not (and (= (str project-id) (str (:project-id read)))
                 (contains? #{:ready :failed} (:status read))))))

(defn read-progress
  "`{:done :total}` of the read's current step, when it reports one."
  [read]
  (let [{:keys [done total]} (get-in read [:progress :params])]
    (when (and (number? done) (number? total) (pos? total))
      {:done done :total total})))

;; --- State readers

(defn get-read
  [state]
  (get-in state (state-path :read)))

(defn chat-locked?
  "True while the chat of the open linked project waits for its read."
  [state]
  (gate-locked? (pf/current-platform state)
                (get-read state)
                (:current-project-id state)))

(defn read-done?
  "True once the open project's read ended well."
  [state]
  (let [read (get-read state)]
    (and (= :ready (:status read))
         (= (str (:current-project-id state)) (str (:project-id read))))))

(defn get-project-link
  "What the daemon said about the folder of `project-id` (string or uuid)."
  [state project-id]
  (get-in state (state-path :projects (str project-id))))

(defn current-design-platform
  "The platform screens of the open project are designed for (see
  `pf/design-platform`); an existing project uses the platform the
  daemon detected in its code."
  [state]
  (let [project-id (:current-project-id state)
        detected   (or (get-in (get-project-link state project-id) [:stack :platform])
                       (get-in (get-read state) [:result :stack :platform]))]
    (pf/design-platform (pf/current-platform state) detected)))

;; --- Desktop app

(defn desktop-bridge
  "The desktop app's folder dialog bridge, or nil in a browser and
  where there is no window (node tests)."
  []
  (let [bridge (some-> js/globalThis (unchecked-get "penforgeDesktopBridge"))]
    (when (and (some? bridge) (fn? (unchecked-get bridge "chooseFolder")))
      bridge)))

;; --- Events: folder browser and link

(defn- handle-message
  [msg]
  (ptk/reify ::handle-message
    ptk/UpdateEvent
    (update [_ state]
      (apply-message state msg))))

(defn- message-stream
  [stream]
  (->> (client/messages stream)
       (rx/filter #(contains? #{"folder.list" "project.linked" "error"} (:type %)))
       (rx/map handle-message)))

(defn list-folder
  "Ask the daemon for the sub-folders and facts of `path`; nil lists the
  drives and the home folder."
  [path]
  (ptk/reify ::list-folder
    ptk/UpdateEvent
    (update [_ state]
      (let [message (proto/folder-list {:path path})]
        (if (client/send! message)
          (update-in state (state-path :browser) merge
                     {:status :loading :rid (:rid message) :requested path})
          (update-in state (state-path :browser) merge
                     {:status :failed :rid nil :requested path
                      :error {:code "not-connected"}}))))))

(defn- refresh-folder
  "List the folder the browser shows again (after a reconnect)."
  []
  (ptk/reify ::refresh-folder
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [path requested]} (get-in state (state-path :browser))]
        (rx/of (list-folder (or path requested)))))))

(defn choose-native-folder
  "Desktop app: pick a folder with the native dialog, then read its
  facts through `folder.list`. Cancelling changes nothing."
  []
  (ptk/reify ::choose-native-folder
    ptk/WatchEvent
    (watch [_ _ _]
      (if-let [^js bridge (desktop-bridge)]
        (->> (rx/from (.chooseFolder bridge))
             (rx/filter string?)
             (rx/map list-folder)
             (rx/catch (fn [cause]
                         (log/warn :hint "native folder dialog failed" :cause cause)
                         (rx/empty))))
        (rx/empty)))))

(defn reset-link
  "Forget the last link request (a new dialog starts clean)."
  []
  (ptk/reify ::reset-link
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path) dissoc :link :browser))))

(defn link-project
  "Link the folder `path` to the project `project-id` of `platform`
  (`:game` or `:existing`)."
  [project-id platform path]
  (ptk/reify ::link-project
    ptk/UpdateEvent
    (update [_ state]
      (let [message (proto/project-link {:project-id project-id
                                         :kind (keyword platform)
                                         :path path})]
        (if (client/send! message)
          (assoc-in state (state-path :link)
                    {:status :pending :rid (:rid message) :project-id (str project-id)})
          (assoc-in state (state-path :link)
                    {:status :failed :project-id (str project-id)
                     :error {:code "not-connected"}}))))))

(defn link-current-project
  "Link `path` to the open project (the chat asks again for a folder the
  daemon does not know)."
  [path]
  (ptk/reify ::link-current-project
    ptk/WatchEvent
    (watch [_ state _]
      (let [project-id (:current-project-id state)
            platform   (pf/current-platform state)]
        (if (and (uuid? project-id) (pf/linked-platform? platform))
          (rx/of (link-project project-id platform path))
          (rx/empty))))))

(defn fetch-link-status
  [project-id]
  (ptk/reify ::fetch-link-status
    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/project-link-status {:project-id project-id})))))

(defn initialize-browser
  "Start the daemon client for the folder step of the create-project
  dialog (dashboard, no `context.set`) and list the drives once
  connected (again after each reconnect)."
  []
  (ptk/reify ::initialize-browser
    ptk/WatchEvent
    (watch [_ state stream]
      (let [stopper (rx/filter #(or (ptk/type? ::finalize-browser %)
                                    (ptk/type? ::initialize-browser %))
                               stream)]
        (->> (rx/merge
              (rx/of (client/initialize))
              (if (= :connected (get-in state [:penforge :connection :status]))
                (rx/of (refresh-folder))
                (rx/empty))
              (->> stream
                   (rx/filter (ptk/type? ::client/connected))
                   (rx/map (fn [_] (refresh-folder))))
              (message-stream stream))
             (rx/take-until stopper))))))

(defn finalize-browser
  "Leave the create-project dialog: close the daemon client."
  []
  (ptk/reify ::finalize-browser
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path) dissoc :browser))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (client/finalize)))))

;; --- Events: background read

(defn- read-started
  [rid project-id]
  (ptk/reify ::read-started
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :read)
                 (fn [read]
                   {:status :running
                    :rid rid
                    :project-id (str project-id)
                    ;; keep the last result (detected stack) while reading again
                    :result (when (= (str project-id) (:project-id read))
                              (:result read))})))))

(defn- read-message
  [rid msg]
  (ptk/reify ::read-message
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (get-in state (state-path :read :rid)))
        (update-in state (state-path :read) apply-read-message msg)
        state))))

(defn start-read
  "Read the open linked project in the background (`project-read`). A
  read that runs or ended well is not started again unless `force`
  (\"Read project again\")."
  ([] (start-read false))
  ([force]
   (ptk/reify ::start-read
     ptk/WatchEvent
     (watch [_ state stream]
       (let [project-id (:current-project-id state)
             read       (get-read state)
             same       (= (str project-id) (:project-id read))]
         (if (or (not (uuid? project-id))
                 (not (pf/linked-platform? (pf/current-platform state)))
                 (and (not force) same (contains? #{:running :ready} (:status read)))
                 (and force same (= :running (:status read))))
           (rx/empty)
           (let [rid (proto/next-rid)]
             (rx/merge
              (->> (chat/workflow-messages stream rid)
                   (rx/map #(read-message rid %))
                   (rx/take-until (rx/filter (ptk/type? ::finalize) stream)))
              (rx/of (read-started rid project-id)
                     (chat/run-workflow "project-read"
                                        (if force {:force true} {})
                                        {:rid rid :silent true}))))))))))

(defn- read-after-link
  "Read again once the folder of a project that needed one is linked."
  [msg]
  (ptk/reify ::read-after-link
    ptk/WatchEvent
    (watch [_ state _]
      (let [read (get-read state)]
        (if (and (:linked msg)
                 (= (:project-id msg) (str (:current-project-id state)))
                 (contains? #{:not-linked :failed} (:status read)))
          (rx/of (start-read true))
          (rx/empty))))))

(def ^:private ref:read-trigger
  (l/derived (fn [state]
               {:connected  (= :connected (get-in state [:penforge :connection :status]))
                :project-id (:current-project-id state)
                :platform   (pf/current-platform state)})
             st/state
             =))

(defn initialize
  "Start the linked-folder side of an open workspace: answers of the
  daemon, and the background read of a linked project once the daemon
  is connected."
  []
  (ptk/reify ::initialize
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/filter #(or (ptk/type? ::finalize %)
                                    (ptk/type? ::initialize %))
                               stream)]
        (->> (rx/merge
              (message-stream stream)
              (->> (rx/from-atom ref:read-trigger {:emit-current-value? true})
                   (rx/filter (fn [{:keys [connected project-id platform]}]
                                (and connected
                                     (uuid? project-id)
                                     (pf/linked-platform? platform))))
                   (rx/mapcat (fn [{:keys [project-id]}]
                                (rx/of (fetch-link-status project-id)
                                       (start-read false)))))
              (->> (client/messages stream)
                   (rx/filter #(= "project.linked" (:type %)))
                   (rx/map read-after-link)))
             (rx/take-until stopper))))))

(defn finalize
  []
  (ptk/reify ::finalize
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path) dissoc :read :browser :link :redesign))))
