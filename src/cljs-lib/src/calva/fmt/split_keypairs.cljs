(ns calva.fmt.split-keypairs
  (:require [cljfmt.core :as cljfmt]
            [rewrite-clj.node :as n]
            [rewrite-clj.parser :as p]))

(defn- split-map-children [children]
  ;; cljfmt 0.16.4 determines key parity by walking every preceding sibling
  ;; for every node (including whitespace). Track that parity in one pass.
  (loop [remaining (seq children), result (transient []), key? true,
         preceding-element? false, line-break? false]
    (if-let [node (first remaining)]
      (let [whitespace? (n/whitespace-or-comment? node)
            discarded? (= :uneval (n/tag node))
            element? (not whitespace?)
            split? (and element? (not discarded?) key?
                        preceding-element? (not line-break?))]
        (recur (next remaining)
               (cond-> result
                 split? (conj! (n/newlines 1))
                 true (conj! node))
               (if (and element? (not discarded?)) (not key?) key?)
               (or preceding-element? element?)
               (if element? false
                   (or line-break? (n/linebreak? node) (n/comment? node)))))
      (persistent! result))))

(defn split-keypairs-over-multiple-lines
  "The cljfmt split pass, linear in the number of nodes, including wide maps.
  Comments, commas and discarded forms retain cljfmt's key/value semantics."
  [form]
  (if (n/inner? form)
    (let [children (mapv split-keypairs-over-multiple-lines (n/children form))]
      (n/replace-children form (if (= :map (n/tag form))
                                (split-map-children children)
                                children)))
    form))

(defn reformat-string [text options]
  (if (:split-keypairs-over-multiple-lines? options)
    ;; Preserve cljfmt's pass order: sorting precedes splitting; all remaining
    ;; formatting/alignment passes still run on the complete original scope.
    (-> (p/parse-string-all text)
        (cond-> (:sort-ns-references? options) cljfmt/sort-ns-references)
        split-keypairs-over-multiple-lines
        (cljfmt/reformat-form (assoc options
                                    :sort-ns-references? false
                                    :split-keypairs-over-multiple-lines? false))
        n/string
        (cond-> (:normalize-newlines-at-file-end? options)
          cljfmt/normalize-newlines-at-file-end))
    (cljfmt/reformat-string text options)))
