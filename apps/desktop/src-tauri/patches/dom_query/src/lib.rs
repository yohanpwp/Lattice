#![allow(missing_docs)]

//! Query, traverse, and transform HTML with CSS selectors.

mod document;
mod dom_tree;
mod entities;
mod matcher;
mod node;
mod selection;

#[cfg(feature = "markdown")]
pub mod serializing;

pub use document::Document;
pub use dom_tree::Tree;
pub use dom_tree::TreeNodeOps;
pub use entities::Attr;
pub use matcher::Matcher;
#[doc(hidden)]
pub use node::SerializableNodeRef;
pub use node::{Element, Node, NodeData, NodeId, NodeIdProver, NodeRef, TreeNode};
pub use selection::Selection;

// re-export
pub use html5ever::{local_name, LocalName};
