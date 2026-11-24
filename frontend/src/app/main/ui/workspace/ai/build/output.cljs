;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.output
  "Output folder of a web or mobile project (W41): where Build and
  Instruct write on this computer.

  The daemon keeps the choice (`project.output.*` messages).
  `ensure-folder` asks for a folder when the project has none (or it
  went away) and goes on once there is one; the folder dialog
  (`output-dialog`) previews what a pick gives and sets it.

  State lives under `[:penforge :output]`:
  `{:projects {<project id string> {:app {:state :path :built}
                                    :output {:state :path}}}
  :picker {:status :checking|:ready|:saving|:failed, :rid, :path,
  :target {:picked :path :sub-folder :existing}, :error}}`. App states
  are `\"none\"` `\"internal\"` (built inside the Penforge folder before
  W41, stays there) `\"ready\"` `\"missing\"`; output states `\"none\"`
  `\"ready\"` `\"missing\"`."
  (:require
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def modal-type
  "Modal id of the folder dialog."
  :penforge-output-folder)

(def reply-timeout-ms
  15000)

;; --- Pure helpers

(defn get-output
  "Output folder of `project-id` as the daemon last said, or nil."
  [state project-id]
  (get-in state [:penforge :output :projects (str project-id)]))

(defn needs-folder?
  "Whether `purpose` (`:build` or `:instruct`) must ask for a folder
  first: none was picked, or the picked one is gone."
  [purpose output]
  (case purpose
    :build    (not (contains? #{"internal" "ready"} (get-in output [:app :state])))
    :instruct (not= "ready" (get-in output [:output :state]))))

(defn get-path
  "Folder `purpose` writes to, or nil when none was picked."
  [purpose output]
  (case purpose
    :build    (get-in output [:app :path])
    :instruct (get-in output [:output :path])))

(defn get-start-path
  "Folder the dialog shows first: the picked one while it exists, nil
  for the drives."
  [output]
  (when (= "ready" (get-in output [:output :state]))
    (get-in output [:output :path])))

(defn get-purpose
  "What \"Change folder\" of the project menu changes: where the app
  goes, once there is one, else only where the next run writes."
  [output]
  (if (= "none" (get-in output [:app :state] "none"))
    :instruct
    :build))

(defn unsupported?
  "Whether a refused request means that the daemon has no output
  folders (server mode, or a daemon before W41)."
  [{:keys [code reason]}]
  (or (contains? #{"not-configured" "not-implemented" "unknown-type"} code)
      (and (= "bad-request" code) (nil? reason))))

(defn apply-check
  "The picker state after the reply to the check `rid` of a folder."
  [picker rid {:keys [type target] :as reply}]
  (cond
    (not= rid (:rid picker))
    picker

    (and (= "project.output" type) (map? target))
    (assoc picker :status :ready :target target :error nil)

    :else
    (assoc picker
           :status :failed
           :target nil
           :error (select-keys reply [:code :reason :message]))))

(defn can-use?
  "Whether the picker's folder `path` was checked and may be used."
  [{:keys [status target] :as picker} path]
  (and (= :ready status)
       (some? target)
       (string? path)
       (= path (:path picker))))

;; --- Requests

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- request
  "Send `message`; a stream of its one reply (an `error` when none
  comes)."
  [stream message]
  (rx/merge
   (->> (client/messages stream)
        (rx/filter #(= (:rid message) (:rid %)))
        (rx/filter #(contains? #{"project.output" "error"} (:type %)))
        (rx/take 1)
        (rx/timeout reply-timeout-ms
                    (rx/of {:type "error" :code "timeout" :rid (:rid message)})))
   (->> (rx/of message)
        (rx/tap client/send!)
        (rx/ignore))))

(defn output-received
  [{:keys [project-id] :as reply}]
  (ptk/reify ::output-received
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:penforge :output :projects (str project-id)]
                (select-keys reply [:app :output])))))

(defn fetch-output
  "Read the output folder of `project-id` from the daemon."
  [project-id]
  (ptk/reify ::fetch-output
    ptk/WatchEvent
    (watch [_ state stream]
      (if (and (some? project-id) (connected? state))
        (->> (request stream (proto/project-output-status {:project-id project-id}))
             (rx/filter #(= "project.output" (:type %)))
             (rx/map output-received))
        (rx/empty)))))

(defn show-picker
  "Show the folder dialog. `on-done` and `on-cancel` are optional fns
  that answer the next event."
  [props]
  (modal/show modal-type props))

(defn change-folder
  "Pick another folder for the open project."
  [purpose on-done on-cancel]
  (ptk/reify ::change-folder
    ptk/WatchEvent
    (watch [_ state _]
      (let [project-id (:current-project-id state)]
        (rx/of (show-picker {:project-id project-id
                             :project-name (get-in state [:projects project-id :name])
                             :purpose purpose
                             :on-done on-done
                             :on-cancel on-cancel}))))))

(defn ensure-folder
  "Make sure the open project has a folder for `purpose`, then emit
  `(on-ready)`. Without one the folder dialog opens; picking a folder
  emits `(on-picked)`, and closing the dialog starts nothing. A daemon
  without output folders goes on as before."
  [purpose on-ready on-picked]
  (ptk/reify ::ensure-folder
    ptk/WatchEvent
    (watch [_ state stream]
      (let [project-id (:current-project-id state)]
        (if (or (nil? project-id) (not (connected? state)))
          ;; the next step tells the user that the AI is not connected
          (rx/of (on-ready))
          (->> (request stream (proto/project-output-status {:project-id project-id}))
               (rx/mapcat
                (fn [reply]
                  (cond
                    (= "project.output" (:type reply))
                    (rx/of (output-received reply)
                           (if (needs-folder? purpose reply)
                             (change-folder purpose on-picked nil)
                             (on-ready)))

                    (unsupported? reply)
                    (rx/of (on-ready))

                    :else
                    (rx/of (ntf/error (tr "penforge.output.error.generic"))))))
               ;; the user opened another file in the meantime
               (rx/take-until (rx/filter (ptk/type? ::client/initialize) stream))))))))

;; --- Folder dialog

(defn- picker-updated
  [f & args]
  (ptk/reify ::picker-updated
    ptk/UpdateEvent
    (update [_ state]
      (apply update-in state [:penforge :output :picker] f args))))

(defn reset-picker
  []
  (ptk/reify ::reset-picker
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :output] dissoc :picker))))

(defn check-folder
  "Ask the daemon which folder picking `path` gives."
  [{:keys [project-id project-name purpose]} path]
  (let [message (proto/project-output-preview {:project-id project-id
                                               :purpose purpose
                                               :name project-name
                                               :path path})
        rid     (:rid message)]
    (ptk/reify ::check-folder
      ptk/UpdateEvent
      (update [_ state]
        (assoc-in state [:penforge :output :picker]
                  {:status :checking :rid rid :path path}))

      ptk/WatchEvent
      (watch [_ _ stream]
        (->> (request stream message)
             (rx/map #(picker-updated apply-check rid %)))))))

(defn set-folder
  "Use the folder the dialog shows, then emit `(on-done)`."
  [{:keys [project-id project-name purpose on-done]} path]
  (let [message (proto/project-output-set {:project-id project-id
                                           :purpose purpose
                                           :name project-name
                                           :path path})]
    (ptk/reify ::set-folder
      ptk/UpdateEvent
      (update [_ state]
        (assoc-in state [:penforge :output :picker :status] :saving))

      ptk/WatchEvent
      (watch [_ _ stream]
        (->> (request stream message)
             (rx/mapcat
              (fn [reply]
                (if (= "project.output" (:type reply))
                  (rx/concat
                   (rx/of (output-received reply)
                          (modal/hide))
                   (if (fn? on-done)
                     (rx/of (on-done))
                     (rx/empty)))
                  (rx/of (picker-updated assoc
                                         :status :failed
                                         :target nil
                                         :error (select-keys reply [:code :reason :message])))))))))))

(defn cancel-picker
  "Close the dialog without a pick; `(on-cancel)` is the event that
  follows, if any."
  [{:keys [on-cancel]}]
  (ptk/reify ::cancel-picker
    ptk/WatchEvent
    (watch [_ _ _]
      (if (fn? on-cancel)
        (rx/of (modal/hide) (on-cancel))
        (rx/of (modal/hide))))))
