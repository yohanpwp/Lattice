use crate::node::{DescendantNodes, NodeRef};
use crate::Tree;

#[derive(Clone, Debug, PartialEq)]
pub enum SimpleSelector {
    Any,
    Tag(String),
    Class(String),
    Id(String),
    AttrExists(String),
    AttrEquals(String, String),
    AttrPrefix(String, String),
    AttrSuffix(String, String),
    AttrContains(String, String),
    AttrIncludes(String, String),
    AttrDashMatch(String, String),
    FirstChild,
    LastChild,
    OnlyChild,
    Empty,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompoundSelector {
    pub simple: Vec<SimpleSelector>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Combinator {
    Descendant,       // ' '
    Child,            // '>'
    NextSibling,      // '+'
    SubsequentSibling,// '~'
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComplexSelector {
    pub target: CompoundSelector,
    // (relationship to ancestor/sibling, matching selector)
    pub relations: Vec<(Combinator, CompoundSelector)>,
}

#[derive(Clone, Debug)]
pub struct Matcher {
    #[allow(dead_code)]
    raw: String,
    selectors: Vec<ComplexSelector>,
}

impl Matcher {
    pub fn new(sel: &str) -> Result<Self, String> {
        let raw = sel.trim().to_string();
        let mut selectors = Vec::new();
        for group_str in split_selector_list(&raw) {
            let complex = parse_complex_selector(&group_str)?;
            selectors.push(complex);
        }
        if selectors.is_empty() {
            return Err("Empty selector".to_string());
        }
        Ok(Self { raw, selectors })
    }

    pub fn match_element(&self, element: &NodeRef<'_>) -> bool {
        if !element.is_element() {
            return false;
        }
        for sel in &self.selectors {
            if matches_compound(element, &sel.target) && match_relations(element, &sel.relations) {
                return true;
            }
        }
        false
    }
}

fn split_selector_list(s: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let mut current = String::new();
    let mut in_bracket = false;
    let mut in_quote = None;

    for c in s.chars() {
        if let Some(q) = in_quote {
            current.push(c);
            if c == q {
                in_quote = None;
            }
        } else if in_bracket {
            current.push(c);
            if c == ']' {
                in_bracket = false;
            }
        } else if c == '"' || c == '\'' {
            in_quote = Some(c);
            current.push(c);
        } else if c == '[' {
            in_bracket = true;
            current.push(c);
        } else if c == ',' {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                groups.push(trimmed);
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        groups.push(trimmed);
    }
    groups
}

fn parse_complex_selector(s: &str) -> Result<ComplexSelector, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("Empty selector".to_string());
    }

    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    let mut i = 0;

    let mut segments: Vec<(CompoundSelector, Option<Combinator>)> = Vec::new();

    while i < len {
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= len {
            break;
        }

        let mut comp_chars = Vec::new();
        while i < len {
            if chars[i] == '[' {
                comp_chars.push(chars[i]);
                i += 1;
                let mut in_quote = None;
                while i < len {
                    let c = chars[i];
                    comp_chars.push(c);
                    i += 1;
                    if let Some(q) = in_quote {
                        if c == q {
                            in_quote = None;
                        }
                    } else if c == '"' || c == '\'' {
                        in_quote = Some(c);
                    } else if c == ']' {
                        break;
                    }
                }
            } else if chars[i] == '"' || chars[i] == '\'' {
                let q = chars[i];
                comp_chars.push(q);
                i += 1;
                while i < len {
                    let c = chars[i];
                    comp_chars.push(c);
                    i += 1;
                    if c == q {
                        break;
                    }
                }
            } else if chars[i].is_whitespace() || chars[i] == '>' || chars[i] == '+' || chars[i] == '~' {
                break;
            } else {
                comp_chars.push(chars[i]);
                i += 1;
            }
        }

        let comp_str: String = comp_chars.into_iter().collect();
        if comp_str.is_empty() {
            return Err("Expected compound selector".to_string());
        }
        let compound = parse_compound_selector(&comp_str)?;

        let mut had_space = false;
        while i < len && chars[i].is_whitespace() {
            had_space = true;
            i += 1;
        }

        if i >= len {
            segments.push((compound, None));
            break;
        }

        let combinator = if chars[i] == '>' {
            i += 1;
            while i < len && chars[i].is_whitespace() {
                i += 1;
            }
            Combinator::Child
        } else if chars[i] == '+' {
            i += 1;
            while i < len && chars[i].is_whitespace() {
                i += 1;
            }
            Combinator::NextSibling
        } else if chars[i] == '~' {
            i += 1;
            while i < len && chars[i].is_whitespace() {
                i += 1;
            }
            Combinator::SubsequentSibling
        } else if had_space {
            Combinator::Descendant
        } else {
            return Err(format!("Unexpected character: {}", chars[i]));
        };

        segments.push((compound, Some(combinator)));
    }

    if segments.is_empty() {
        return Err("Empty selector".to_string());
    }

    let (target, last_comb) = segments.pop().unwrap();
    if last_comb.is_some() {
        return Err("Dangling combinator at end of selector".to_string());
    }

    let mut relations = Vec::new();
    while let Some((compound, comb)) = segments.pop() {
        let c = comb.ok_or_else(|| "Missing combinator between compound selectors".to_string())?;
        relations.push((c, compound));
    }

    Ok(ComplexSelector { target, relations })
}

fn parse_compound_selector(s: &str) -> Result<CompoundSelector, String> {
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut simple = Vec::new();

    if i < len && chars[i] != '.' && chars[i] != '#' && chars[i] != '[' && chars[i] != ':' {
        let start = i;
        while i < len && chars[i] != '.' && chars[i] != '#' && chars[i] != '[' && chars[i] != ':' {
            i += 1;
        }
        let tag: String = chars[start..i].iter().collect();
        if tag == "*" {
            simple.push(SimpleSelector::Any);
        } else if !tag.is_empty() {
            simple.push(SimpleSelector::Tag(tag.to_lowercase()));
        }
    }

    while i < len {
        match chars[i] {
            '.' => {
                i += 1;
                let start = i;
                while i < len && chars[i] != '.' && chars[i] != '#' && chars[i] != '[' && chars[i] != ':' {
                    i += 1;
                }
                let cls: String = chars[start..i].iter().collect();
                if !cls.is_empty() {
                    simple.push(SimpleSelector::Class(cls));
                }
            }
            '#' => {
                i += 1;
                let start = i;
                while i < len && chars[i] != '.' && chars[i] != '#' && chars[i] != '[' && chars[i] != ':' {
                    i += 1;
                }
                let id: String = chars[start..i].iter().collect();
                if !id.is_empty() {
                    simple.push(SimpleSelector::Id(id));
                }
            }
            '[' => {
                i += 1;
                let start = i;
                let mut in_quote = None;
                while i < len {
                    if let Some(q) = in_quote {
                        if chars[i] == q {
                            in_quote = None;
                        }
                    } else if chars[i] == '"' || chars[i] == '\'' {
                        in_quote = Some(chars[i]);
                    } else if chars[i] == ']' {
                        break;
                    }
                    i += 1;
                }
                let attr_content: String = chars[start..i].iter().collect();
                if i < len && chars[i] == ']' {
                    i += 1;
                }
                simple.push(parse_attr_selector(&attr_content));
            }
            ':' => {
                i += 1;
                let start = i;
                while i < len && chars[i] != '.' && chars[i] != '#' && chars[i] != '[' && chars[i] != ':' {
                    i += 1;
                }
                let pseudo: String = chars[start..i].iter().collect();
                match pseudo.to_lowercase().as_str() {
                    "first-child" => simple.push(SimpleSelector::FirstChild),
                    "last-child" => simple.push(SimpleSelector::LastChild),
                    "only-child" => simple.push(SimpleSelector::OnlyChild),
                    "empty" => simple.push(SimpleSelector::Empty),
                    _ => {}
                }
            }
            _ => {
                i += 1;
            }
        }
    }

    if simple.is_empty() {
        return Err(format!("Invalid compound selector: {}", s));
    }

    Ok(CompoundSelector { simple })
}

fn parse_attr_selector(content: &str) -> SimpleSelector {
    let content = content.trim();
    let ops = [("^=", 1), ("$=", 2), ("*=", 3), ("~=", 4), ("|=", 5), ("=", 6)];
    for (op, code) in ops {
        if let Some(idx) = content.find(op) {
            let attr = content[..idx].trim().to_lowercase();
            let val = content[idx + op.len()..]
                .trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .to_string();
            return match code {
                1 => SimpleSelector::AttrPrefix(attr, val),
                2 => SimpleSelector::AttrSuffix(attr, val),
                3 => SimpleSelector::AttrContains(attr, val),
                4 => SimpleSelector::AttrIncludes(attr, val),
                5 => SimpleSelector::AttrDashMatch(attr, val),
                _ => SimpleSelector::AttrEquals(attr, val),
            };
        }
    }
    SimpleSelector::AttrExists(content.to_lowercase())
}

fn matches_compound(node: &NodeRef<'_>, compound: &CompoundSelector) -> bool {
    if !node.is_element() {
        return false;
    }
    for simple in &compound.simple {
        if !matches_simple(node, simple) {
            return false;
        }
    }
    true
}

fn match_relations(current: &NodeRef<'_>, relations: &[(Combinator, CompoundSelector)]) -> bool {
    if relations.is_empty() {
        return true;
    }
    let (comb, compound) = &relations[0];
    let rest = &relations[1..];
    match comb {
        Combinator::Child => {
            if let Some(parent) = get_parent_element(current) {
                if matches_compound(&parent, compound) && match_relations(&parent, rest) {
                    return true;
                }
            }
            false
        }
        Combinator::Descendant => {
            let mut curr = get_parent_element(current);
            while let Some(ancestor) = curr {
                if matches_compound(&ancestor, compound) && match_relations(&ancestor, rest) {
                    return true;
                }
                curr = get_parent_element(&ancestor);
            }
            false
        }
        Combinator::NextSibling => {
            if let Some(prev) = get_prev_sibling_element(current) {
                if matches_compound(&prev, compound) && match_relations(&prev, rest) {
                    return true;
                }
            }
            false
        }
        Combinator::SubsequentSibling => {
            let mut curr = get_prev_sibling_element(current);
            while let Some(prev) = curr {
                if matches_compound(&prev, compound) && match_relations(&prev, rest) {
                    return true;
                }
                curr = get_prev_sibling_element(&prev);
            }
            false
        }
    }
}

fn get_parent_element<'a>(node: &NodeRef<'a>) -> Option<NodeRef<'a>> {
    node.parent().filter(|p| p.is_element())
}

fn get_prev_sibling_element<'a>(node: &NodeRef<'a>) -> Option<NodeRef<'a>> {
    let mut curr = node.prev_sibling();
    while let Some(sibling) = curr {
        if sibling.is_element() {
            return Some(sibling);
        }
        curr = sibling.prev_sibling();
    }
    None
}

fn get_next_sibling_element<'a>(node: &NodeRef<'a>) -> Option<NodeRef<'a>> {
    let mut curr = node.next_sibling();
    while let Some(sibling) = curr {
        if sibling.is_element() {
            return Some(sibling);
        }
        curr = sibling.next_sibling();
    }
    None
}

fn matches_simple(node: &NodeRef<'_>, sel: &SimpleSelector) -> bool {
    if !node.is_element() {
        return false;
    }
    match sel {
        SimpleSelector::Any => true,
        SimpleSelector::Tag(tag) => node.node_name().is_some_and(|n| n.eq_ignore_ascii_case(tag)),
        SimpleSelector::Class(cls) => node.has_class(cls),
        SimpleSelector::Id(id) => node.id_attr().is_some_and(|i| i.as_ref() == id),
        SimpleSelector::AttrExists(attr) => node.has_attr(attr),
        SimpleSelector::AttrEquals(attr, val) => node.attr(attr).is_some_and(|v| v.as_ref() == val),
        SimpleSelector::AttrPrefix(attr, prefix) => node.attr(attr).is_some_and(|v| v.starts_with(prefix)),
        SimpleSelector::AttrSuffix(attr, suffix) => node.attr(attr).is_some_and(|v| v.ends_with(suffix)),
        SimpleSelector::AttrContains(attr, sub) => node.attr(attr).is_some_and(|v| v.contains(sub)),
        SimpleSelector::AttrIncludes(attr, word) => {
            node.attr(attr).is_some_and(|v| v.split_whitespace().any(|w| w == word))
        }
        SimpleSelector::AttrDashMatch(attr, prefix) => {
            node.attr(attr).is_some_and(|v| v.as_ref() == prefix || v.starts_with(&format!("{}-", prefix)))
        }
        SimpleSelector::FirstChild => get_prev_sibling_element(node).is_none() && node.parent().is_some(),
        SimpleSelector::LastChild => get_next_sibling_element(node).is_none() && node.parent().is_some(),
        SimpleSelector::OnlyChild => {
            get_prev_sibling_element(node).is_none()
                && get_next_sibling_element(node).is_none()
                && node.parent().is_some()
        }
        SimpleSelector::Empty => node.children().iter().all(|c| !c.is_element() && c.text().trim().is_empty()),
    }
}

pub struct DescendantMatches<'a, 'b> {
    iter: DescendantNodes<'a>,
    matcher: &'b Matcher,
    tree: &'a Tree,
}

impl<'a, 'b> DescendantMatches<'a, 'b> {
    pub fn new(root_node: NodeRef<'a>, matcher: &'b Matcher) -> Self {
        let tree = root_node.tree;
        Self {
            iter: tree.descendant_ids_of_it(&root_node.id),
            matcher,
            tree,
        }
    }
}

impl<'a> Iterator for DescendantMatches<'a, '_> {
    type Item = NodeRef<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        for node_id in self.iter.by_ref() {
            let node = NodeRef::new(node_id, self.tree);
            if !node.is_element() {
                continue;
            }
            if self.matcher.match_element(&node) {
                return Some(node);
            }
        }
        None
    }
}

pub struct Matches<'a, 'b> {
    nodes: Vec<NodeRef<'a>>,
    matcher: &'b Matcher,
    index: usize,
}

impl<'a, 'b> Matches<'a, 'b> {
    pub fn new<I: Iterator<Item = NodeRef<'a>>>(root_nodes: I, matcher: &'b Matcher) -> Self {
        let nodes = root_nodes
            .flat_map(|node| node.children_it(true).filter(|n| n.is_element()))
            .collect();
        Self {
            nodes,
            matcher,
            index: 0,
        }
    }
}

impl<'a> Iterator for Matches<'a, '_> {
    type Item = NodeRef<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while self.index < self.nodes.len() {
            let node = self.nodes[self.index];
            self.index += 1;
            if self.matcher.match_element(&node) {
                return Some(node);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use crate::Document;

    #[test]
    fn test_compound_selector_and_relationship_constraints() {
        let html = r#"
        <!DOCTYPE html>
        <html>
        <head>
            <title>Test Page</title>
            <script src="head_app.js"></script>
            <script>console.log("inline");</script>
        </head>
        <body>
            <img src="logo.png" alt="Logo">
            <div id="content" class="container main">
                <p class="intro">Paragraph 1</p>
                <p>Paragraph 2</p>
            </div>
            <script src="body_app.js"></script>
        </body>
        </html>
        "#;

        let doc = Document::from(html);

        // [P2 reproduction 1] script[src] must select only scripts with src, NOT images or inline scripts
        let script_src = doc.select("script[src]");
        assert_eq!(script_src.length(), 2);
        assert_eq!(script_src.nodes()[0].attr("src").unwrap().as_ref(), "head_app.js");
        assert_eq!(script_src.nodes()[1].attr("src").unwrap().as_ref(), "body_app.js");

        // [P2 reproduction 2] head > script must select scripts directly under head, NOT inside body
        let head_script = doc.select("head > script");
        assert_eq!(head_script.length(), 2);
        for node in head_script.nodes() {
            assert_eq!(node.parent().unwrap().node_name().unwrap().as_ref(), "head");
        }

        // head > script[src] combines compound constraint and child combinator
        let head_script_src = doc.select("head > script[src]");
        assert_eq!(head_script_src.length(), 1);
        assert_eq!(head_script_src.nodes()[0].attr("src").unwrap().as_ref(), "head_app.js");

        // body > script must select body script only
        let body_script = doc.select("body > script");
        assert_eq!(body_script.length(), 1);
        assert_eq!(body_script.nodes()[0].attr("src").unwrap().as_ref(), "body_app.js");

        // Descendant combinator head script does NOT select body script
        let head_descendant_script = doc.select("head script");
        assert_eq!(head_descendant_script.length(), 2);

        // Multiple classes on compound selector
        let multi_class = doc.select("div.container.main");
        assert_eq!(multi_class.length(), 1);
        assert_eq!(multi_class.nodes()[0].id_attr().unwrap().as_ref(), "content");

        // ID and class on compound selector
        let id_and_class = doc.select("div#content.container");
        assert_eq!(id_and_class.length(), 1);

        // Child combinator with classes
        let child_p = doc.select("div#content > p.intro");
        assert_eq!(child_p.length(), 1);

        // Non-existent compound match
        let no_match = doc.select("img[alt='Logo'].notfound");
        assert_eq!(no_match.length(), 0);
    }
}
