;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.project-fonts
  "Imports the font files of a linked Game UI / Existing project into
  the team's fonts once its folder was read, so the AI and the user
  design with the project's own fonts. Families Penpot already has
  (Google Fonts, local fonts) and variants the team already uploaded
  are skipped; Google Fonts families need no import at all."
  (:require
   [app.common.logging :as log]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.fonts :as df]
   [app.main.fonts :as fonts]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

;; Projects imported in this tab: the daemon's answer does not change
;; while the folder stays the same.
(defonce ^:private imported (atom #{}))

(defn- variant-key
  [{:keys [font-family font-weight font-style]}]
  [font-family (str font-weight) font-style])

(defn new-variant?
  "Whether a processed font `item` (`:font-family`, `:font-weight`,
  `:font-style`) should be uploaded: its family is not a built-in or
  Google font (`catalog-family` finds one, nil when none), and the team
  fonts (`team-fonts`, variants by id) do not hold the same variant."
  [item catalog-family team-fonts]
  (and (not (contains? #{:google :builtin} (:backend catalog-family)))
       (not-any? #(= (variant-key item) (variant-key %)) (vals team-fonts))))

(defn- base64->file
  [name data]
  (let [bytes (js/Uint8Array.from (js/atob data) #(.charCodeAt % 0))]
    (js/File. #js [bytes] name)))

(defn- upload
  "Uploads the new variants of `files` (`[{:name :data}]`) for `team-id`
  and refreshes the team's fonts."
  [files team-id team-fonts]
  (->> (df/process-upload (mapv (fn [{:keys [name data]}] (base64->file name data)) files) team-id)
       (rx/map (fn [processed]
                 (->> (df/merge-and-group-fonts {} team-fonts processed)
                      (vals)
                      (filterv #(new-variant? % (fonts/find-font-family (:font-family %)) team-fonts)))))
       (rx/mapcat (fn [items]
                    (if (empty? items)
                      (rx/empty)
                      (->> (rx/from items)
                           (rx/mapcat df/upload-font-variant)
                           (rx/reduce conj [])
                           (rx/tap #(log/info :hint "project fonts imported" :variants (count %)))
                           (rx/map (fn [_] (df/fetch-fonts team-id)))))))
       (rx/catch (fn [cause]
                   (log/warn :hint "could not import the project's fonts" :cause cause)
                   (rx/empty)))))

(defn import-fonts
  "Ask the daemon for the font files of the open linked project and
  import the new ones into the team's fonts (once per project and tab)."
  []
  (ptk/reify ::import-fonts
    ptk/WatchEvent
    (watch [_ state stream]
      (let [project-id (some-> (:current-project-id state) str)
            team-id    (:current-team-id state)
            message    (when project-id (proto/fonts-files {:project-id project-id}))]
        (if (or (nil? message)
                (nil? team-id)
                (contains? @imported project-id)
                (not (client/send! message)))
          (rx/empty)
          (do
            (swap! imported conj project-id)
            (->> (client/messages stream)
                 (rx/filter #(and (= "fonts.files" (:type %)) (= (:rid message) (:rid %))))
                 (rx/take 1)
                 (rx/timeout 60000 (rx/empty))
                 (rx/mapcat (fn [{:keys [files]}]
                              (if (seq files)
                                (upload files team-id (:fonts state))
                                (rx/empty)))))))))))
