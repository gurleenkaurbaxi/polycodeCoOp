"""
Tree-sitter Parser Adapter

Uses tree-sitter to parse various languages and extract IR facts.
"""

from typing import List, Dict, Any, Optional
import tree_sitter
from tree_sitter import Language, Parser
import tree_sitter_languages
from .base import BaseParser, IRFact

class TreeSitterParser(BaseParser):
    """
    Generic parser using Tree-sitter.
    Strings node types to IR facts based on language configuration.
    """
    
    def __init__(self, language_name: str):
        self.language_name = language_name
        self.language = tree_sitter_languages.get_language(language_name)
        self.parser = Parser()
        self.parser.set_language(self.language)
        
        # Mapping configuration
        self.mapping = self._get_mapping(language_name)
        self.scope_nodes = self._get_scope_config(language_name)

    def parse(self, source_code: str, file_path: str) -> List[IRFact]:
        tree = self.parser.parse(bytes(source_code, "utf8"))
        facts = []
        
        cursor = tree.walk()
        
        # Walk with global scope
        self._walk(cursor, facts, source_code, ["<global>"])
        
        return facts

    def _walk(self, cursor: tree_sitter.TreeCursor, facts: List[IRFact], source_code: str, scope_stack: List[str]):
        """
        Recursively walk the tree and extract facts.
        Tracks the current function scope.
        """
        # Determine if we are entering a new scope
        pushed_scope = False
        if cursor.node.type in self.scope_nodes:
            # Extract name for new scope
            scope_name = self._extract_scope_name(cursor.node, source_code)
            scope_stack.append(scope_name)
            pushed_scope = True
        
        # Check if current node is interesting
        if cursor.node.type in self.mapping:
            try:
                # Context is the scope WHERE the fact occurs.
                # If we just pushed a scope (we are defining a function), the context is the OUTER scope.
                # If we are in a call, the context is the CURRENT scope.
                
                context = scope_stack[-2] if pushed_scope and len(scope_stack) > 1 else scope_stack[-1]
                if pushed_scope and len(scope_stack) == 1: context = "<global>"
                
                handler = self.mapping[cursor.node.type]
                fact = handler(cursor.node, source_code, context)
                if fact:
                    facts.append(fact)
            except Exception as e:
                print(f"Error handling {cursor.node.type}: {e}")
        
        # Visit children
        if cursor.goto_first_child():
            while True:
                self._walk(cursor, facts, source_code, scope_stack)
                if not cursor.goto_next_sibling():
                    break
            cursor.goto_parent()
            
        # Exit scope
        if pushed_scope:
            scope_stack.pop()

    def _get_text(self, node, source_code: str) -> str:
        """Helper to get text content of a node."""
        return source_code.encode('utf8')[node.start_byte:node.end_byte].decode('utf8')
    
    def _get_preceding_comment(self, node, source_code: str) -> str:
        """
        Extract comment block immediately before a node as docstring.
        Looks at previous siblings for comments.
        """
        if not node.parent:
            return ""
        
        # Find this node's index among siblings
        siblings = node.parent.children
        node_index = -1
        for i, sibling in enumerate(siblings):
            if sibling == node:
                node_index = i
                break
        
        if node_index <= 0:
            return ""
        
        # Walk backwards collecting comments
        comments = []
        for i in range(node_index - 1, -1, -1):
            sibling = siblings[i]
            if sibling.type in ["comment", "line_comment", "block_comment"]:
                text = self._get_text(sibling, source_code).strip()
                # Remove comment markers
                text = text.lstrip('#').lstrip('//').lstrip('/*').rstrip('*/').strip()
                comments.insert(0, text)
            elif sibling.type not in ["\n", "newline", " "]:
                # Stop at non-comment, non-whitespace
                break
        
        return " ".join(comments) if comments else ""


    def _extract_scope_name(self, node, source: str) -> str:
        """Extract name from a scope-creating node."""
        config = self.scope_nodes.get(node.type)
        if not config:
            return "<anon>"
            
        if config["method"] == "field":
            child = node.child_by_field_name(config["field"])
            return self._get_text(child, source) if child else "<anon>"
        elif config["method"] == "ruby_method":
            # Special handling for Ruby
            name_node = node.child_by_field_name("name")
            if not name_node:
                for child in node.children:
                    if child.type == "identifier":
                        name_node = child
                        break
            return self._get_text(name_node, source) if name_node else "<anon>"
        elif config["method"] == "c_function":
            # Special handling for C function_definition
            declarator = node.child_by_field_name("declarator")
            if declarator:
                func_decl = declarator
                while func_decl.type != "function_declarator" and func_decl.child_count > 0:
                    found = False
                    for child in func_decl.children:
                        if child.type == "function_declarator":
                            func_decl = child
                            found = True
                            break
                    if not found: break
                
                if func_decl.type == "function_declarator":
                    declarator_node = func_decl.child_by_field_name("declarator")
                    if declarator_node:
                        return self._get_text(declarator_node, source)
            return "<anon>"
        return "<anon>"

    def _get_scope_config(self, language_name: str) -> Dict[str, Any]:
        """Configuration for nodes that create a new scope."""
        if language_name == "python":
            return {"function_definition": {"method": "field", "field": "name"}}
        elif language_name == "go":
            return {
                "function_declaration": {"method": "field", "field": "name"},
                "method_declaration": {"method": "field", "field": "name"}
            }
        elif language_name == "java":
            return {
                "method_declaration": {"method": "field", "field": "name"},
                "class_declaration": {"method": "field", "field": "name"},
                "interface_declaration": {"method": "field", "field": "name"},
            }
        elif language_name == "c":
            return {"function_definition": {"method": "c_function"}}
        elif language_name == "rust":
            return {"function_item": {"method": "field", "field": "name"}}
        elif language_name == "ruby":
            return {
                "method": {"method": "ruby_method"},
                "singleton_method": {"method": "ruby_method"}
            }
        return {}

    def _get_mapping(self, language_name: str) -> Dict[str, Any]:
        if language_name == "python": return self._python_mapping()
        elif language_name == "go": return self._go_mapping()
        elif language_name == "java": return self._java_mapping()
        elif language_name == "c": return self._c_mapping()
        elif language_name == "rust": return self._rust_mapping()
        elif language_name == "ruby": return self._ruby_mapping()
        else: return {}

    # =========================================================================
    # Mappings (Updated signatures)
    # =========================================================================

    def _python_mapping(self):
        return {
            # Core
            "function_definition": self._handle_function_def_python,
            "call": self._handle_call_python,
            "return_statement": self._handle_return_python,
            
            # Imports
            "import_statement": self._handle_import_python,
            "import_from_statement": self._handle_import_from_python,
            
            # Classes
            "class_definition": self._handle_class_python,
            
            # Control structures
            "if_statement": self._handle_if_python,
            "for_statement": self._handle_for_python,
            "while_statement": self._handle_while_python,
            "try_statement": self._handle_try_python,
            
            # Exceptions
            "raise_statement": self._handle_raise_python,
            "except_clause": self._handle_except_python,
            
            # Advanced
            "lambda": self._handle_lambda_python,
            "await": self._handle_await_python,
            "attribute": self._handle_attribute_python,
        }

    def _handle_function_def_python(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        params_node = node.child_by_field_name("parameters")
        param_count = 0
        parameters = []
        if params_node:
            for child in params_node.children:
                if child.type == "identifier":
                    param_count += 1
                    parameters.append({"name": self._get_text(child, source), "type": ""})
                elif child.type == "typed_parameter":
                    param_count += 1
                    param_name = ""
                    param_type = ""
                    for subchild in child.children:
                        if subchild.type == "identifier":
                            param_name = self._get_text(subchild, source)
                        elif subchild.type == "type":
                            param_type = self._get_text(subchild, source)
                    parameters.append({"name": param_name, "type": param_type})
        
        # Extract return type
        return_type = ""
        return_type_node = node.child_by_field_name("return_type")
        if return_type_node:
            return_type = self._get_text(return_type_node, source)
        
        # Extract decorators
        decorators = []
        # In tree-sitter-python, decorators are often children of a parent 'decorated_definition' 
        # node if they exist.
        search_node = node
        if node.parent and node.parent.type == "decorated_definition":
            search_node = node.parent
            
        for child in search_node.children:
            if child.type == "decorator":
                dec_text = self._get_text(child, source)
                # Remove @ symbol
                decorators.append(dec_text.lstrip('@').strip())
        
        # Extract docstring (first string in body)
        docstring = ""
        body = node.child_by_field_name("body")
        if body and body.child_count > 0:
            first_stmt = body.children[0]
            if first_stmt.type == "expression_statement":
                expr = first_stmt.children[0] if first_stmt.child_count > 0 else None
                if expr and expr.type == "string":
                    docstring = self._get_text(expr, source).strip('"\'\'\'\'"""')

        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": scope,
            "return_type": return_type,
            "decorators": decorators,
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_python(self, node, source: str, scope: str) -> IRFact:
        func_node = node.child_by_field_name("function")
        callee = self._get_text(func_node, source) if func_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
            arg_count = len(args_node.children) - 2
            if arg_count < 0: arg_count = 0

        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_python(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": len(node.children) > 1
        }, node.start_point[0] + 1)

    def _handle_import_python(self, node, source: str, scope: str) -> IRFact:
        # import module or import module as alias
        module_name = ""
        for child in node.children:
            if child.type == "dotted_name" or child.type == "identifier":
                module_name = self._get_text(child, source)
                break
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": [],
            "is_wildcard": False
        }, node.start_point[0] + 1)

    def _handle_import_from_python(self, node, source: str, scope: str) -> IRFact:
        # from module import name1, name2 [as alias]
        module_name = ""
        imported_names = []
        is_wildcard = False
        
        for child in node.children:
            if child.type == "dotted_name":
                module_name = self._get_text(child, source)
            elif child.type == "wildcard_import":
                is_wildcard = True
            elif child.type == "aliased_import" or child.type == "dotted_name":
                name = self._get_text(child, source)
                if name and name != module_name:
                    imported_names.append(name)
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": imported_names,
            "is_wildcard": is_wildcard
        }, node.start_point[0] + 1)

    def _handle_class_python(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        base_classes = []
        superclasses = node.child_by_field_name("superclasses")
        if superclasses:
            for child in superclasses.children:
                if child.type == "identifier" or child.type == "attribute":
                    base_classes.append(self._get_text(child, source))
        
        # Extract decorators
        decorators = []
        search_node = node
        if node.parent and node.parent.type == "decorated_definition":
            search_node = node.parent
            
        for child in search_node.children:
            if child.type == "decorator":
                dec_text = self._get_text(child, source)
                decorators.append(dec_text.lstrip('@').strip())
        
        # Extract docstring
        docstring = ""
        body = node.child_by_field_name("body")
        if body and body.child_count > 0:
            first_stmt = body.children[0]
            if first_stmt.type == "expression_statement":
                expr = first_stmt.children[0] if first_stmt.child_count > 0 else None
                if expr and expr.type == "string":
                    docstring = self._get_text(expr, source).strip('"\'\'\'\'"""')
        
        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": base_classes,
            "decorators": decorators,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_if_python(self, node, source: str, scope: str) -> IRFact:
        has_else = any(child.type == "else_clause" for child in node.children)
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_for_python(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_while_python(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_try_python(self, node, source: str, scope: str) -> IRFact:
        has_else = any(child.type == "else_clause" for child in node.children)
        return IRFact("ControlStructure", {
            "type": "TRY",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_raise_python(self, node, source: str, scope: str) -> IRFact:
        exception_type = "<unknown>"
        has_message = False
        
        for child in node.children:
            if child.type == "identifier" or child.type == "call":
                exception_type = self._get_text(child, source).split("(")[0]
                has_message = "(" in self._get_text(child, source)
                break
        
        return IRFact("ThrowStatement", {
            "exception_type": exception_type,
            "parent_function": scope,
            "has_message": has_message
        }, node.start_point[0] + 1)

    def _handle_except_python(self, node, source: str, scope: str) -> IRFact:
        exception_types = []
        is_catch_all = True
        
        for child in node.children:
            if child.type == "identifier" or child.type == "attribute":
                exception_types.append(self._get_text(child, source))
                is_catch_all = False
        
        return IRFact("CatchClause", {
            "exception_types": exception_types,
            "parent_function": scope,
            "is_catch_all": is_catch_all
        }, node.start_point[0] + 1)

    def _handle_lambda_python(self, node, source: str, scope: str) -> IRFact:
        params = node.child_by_field_name("parameters")
        param_count = 0
        if params:
            param_count = sum(1 for child in params.children if child.type == "identifier")
        
        return IRFact("LambdaDeclared", {
            "param_count": param_count,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_await_python(self, node, source: str, scope: str) -> IRFact:
        awaited_function = "<unknown>"
        for child in node.children:
            if child.type == "call":
                func_node = child.child_by_field_name("function")
                if func_node:
                    awaited_function = self._get_text(func_node, source)
                break
        
        return IRFact("AwaitExpression", {
            "awaited_function": awaited_function,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_attribute_python(self, node, source: str, scope: str) -> IRFact:
        object_name = ""
        member_name = ""
        
        obj_node = node.child_by_field_name("object")
        if obj_node:
            object_name = self._get_text(obj_node, source)
        
        attr_node = node.child_by_field_name("attribute")
        if attr_node:
            member_name = self._get_text(attr_node, source)
        
        # Check if parent is a call (method call vs property access)
        is_method_call = node.parent and node.parent.type == "call"
        
        return IRFact("MemberAccess", {
            "object_name": object_name,
            "member_name": member_name,
            "parent_function": scope,
            "is_method_call": is_method_call
        }, node.start_point[0] + 1)


    def _go_mapping(self):
        return {
            # Core
            "function_declaration": self._handle_func_decl_go,
            "method_declaration": self._handle_func_decl_go,  # Methods use same handler
            "call_expression": self._handle_call_go,
            "return_statement": self._handle_return_go,
            
            # Imports
            "import_declaration": self._handle_import_go,
            
            # Types
            "type_declaration": self._handle_type_go,  # Handles structs
            "interface_type": self._handle_interface_go,
            
            # Control structures
            "if_statement": self._handle_if_go,
            "for_statement": self._handle_for_go,
            "expression_switch_statement": self._handle_switch_go,
            "type_switch_statement": self._handle_switch_go,
            
            # Concurrency
            "go_statement": self._handle_goroutine_go,
            "channel_type": self._handle_channel_go,
            
            # Member access
            "selector_expression": self._handle_selector_go,
        }

    def _handle_func_decl_go(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        params_node = node.child_by_field_name("parameters")
        param_count = 0
        parameters = []
        if params_node:
            for child in params_node.children:
                if child.type == "parameter_declaration":
                    param_count += 1
                    # Go params: name type or just type
                    param_name = ""
                    param_type = ""
                    for subchild in child.children:
                        if subchild.type == "identifier":
                            if not param_name:
                                param_name = self._get_text(subchild, source)
                        elif subchild.type in ["type_identifier", "pointer_type", "slice_type", "array_type"]:
                            param_type = self._get_text(subchild, source)
                    if not param_name:
                        param_name = f"param{param_count}"
                    parameters.append({"name": param_name, "type": param_type})
        
        # Extract return type
        return_type = ""
        result_node = node.child_by_field_name("result")
        if result_node:
            if result_node.type in ["type_identifier", "pointer_type"]:
                return_type = self._get_text(result_node, source)
            elif result_node.type == "parameter_list":
                # Multiple return values
                types = []
                for child in result_node.children:
                    if child.type in ["type_identifier", "parameter_declaration"]:
                        types.append(self._get_text(child, source))
                return_type = ", ".join(types) if types else ""
        
        # For method_declaration, extract receiver type as parent_scope so that
        # struct methods (e.g. func (p *TCPPeer) Send()) get parent_scope="TCPPeer"
        # instead of "<global>".  Package-level functions keep parent_scope=scope.
        receiver_node = node.child_by_field_name("receiver")
        parent_scope = scope
        if receiver_node:
            for child in receiver_node.children:
                if child.type == "parameter_declaration":
                    for subchild in child.children:
                        if subchild.type == "type_identifier":
                            parent_scope = self._get_text(subchild, source)
                            break
                        elif subchild.type == "pointer_type":
                            # *TypeName → drill into type_identifier child
                            for ptr_child in subchild.children:
                                if ptr_child.type == "type_identifier":
                                    parent_scope = self._get_text(ptr_child, source)
                                    break
                            break
                    if parent_scope != scope:
                        break

        # Extract Go doc comments
        docstring = self._get_preceding_comment(node, source)

        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": parent_scope,
            "return_type": return_type,
            "decorators": [],  # Go doesn't have decorators
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_go(self, node, source: str, scope: str) -> IRFact:
        func_node = node.child_by_field_name("function")
        callee = self._get_text(func_node, source) if func_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
            arg_count = len(args_node.children) - 2
            if arg_count < 0: arg_count = 0
            
        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_go(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": len(node.children) > 1 
        }, node.start_point[0] + 1)

    def _handle_import_go(self, node, source: str, scope: str) -> IRFact:
        # import "fmt" or import ( "fmt" "os" )
        module_name = ""
        imported_names = []
        
        # Single import
        for child in node.children:
            if child.type == "import_spec":
                path = child.child_by_field_name("path")
                if path:
                    name = self._get_text(path, source).strip('"')
                    if not module_name:
                        module_name = name
                    imported_names.append(name)
            elif child.type == "interpreted_string_literal":
                module_name = self._get_text(child, source).strip('"')
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": imported_names if len(imported_names) > 1 else [],
            "is_wildcard": False
        }, node.start_point[0] + 1)

    def _handle_type_go(self, node, source: str, scope: str) -> IRFact:
        # type MyStruct struct { ... } or type MyInt int
        name = "<anon>"
        
        # Get type name
        for child in node.children:
            if child.type == "type_spec":
                name_node = child.child_by_field_name("name")
                if name_node:
                    name = self._get_text(name_node, source)
                break
        
        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": []
        }, node.start_point[0] + 1)

    def _handle_interface_go(self, node, source: str, scope: str) -> IRFact:
        # interface { Method() }
        name = "<anon>"
        method_count = 0
        
        # Count methods in interface
        for child in node.children:
            if child.type == "method_elem":
                method_count += 1
        
        return IRFact("InterfaceDeclared", {
            "name": name,
            "base_interfaces": [],
            "method_count": method_count
        }, node.start_point[0] + 1)

    def _handle_if_go(self, node, source: str, scope: str) -> IRFact:
        has_else = any(child.type == "block" and i > 0 for i, child in enumerate(node.children))
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_for_go(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_switch_go(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "SWITCH",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_goroutine_go(self, node, source: str, scope: str) -> IRFact:
        # go func() or go someFunc()
        func_name = "<anon>"
        for child in node.children:
            if child.type == "call_expression":
                func_node = child.child_by_field_name("function")
                if func_node:
                    func_name = self._get_text(func_node, source)
                break
        
        # Treat goroutine as async function call
        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": f"go {func_name}",
            "arg_count": 0
        }, node.start_point[0] + 1)

    def _handle_channel_go(self, node, source: str, scope: str) -> IRFact:
        # chan Type or <-chan Type
        # Could track as a special variable type, but for now skip
        return None

    def _handle_selector_go(self, node, source: str, scope: str) -> IRFact:
        # obj.field or pkg.Function
        object_name = ""
        member_name = ""
        
        operand = node.child_by_field_name("operand")
        if operand:
            object_name = self._get_text(operand, source)
        
        field = node.child_by_field_name("field")
        if field:
            member_name = self._get_text(field, source)
        
        is_method_call = node.parent and node.parent.type == "call_expression"
        
        return IRFact("MemberAccess", {
            "object_name": object_name,
            "member_name": member_name,
            "parent_function": scope,
            "is_method_call": is_method_call
        }, node.start_point[0] + 1)


    def _java_mapping(self):
        return {
            # Core
            "method_declaration": self._handle_method_java,
            "method_invocation": self._handle_call_java,
            "return_statement": self._handle_return_java,
            
            # Imports
            "import_declaration": self._handle_import_java,
            
            # Classes and Interfaces
            "class_declaration": self._handle_class_java,
            "interface_declaration": self._handle_interface_java,
            "enum_declaration": self._handle_enum_java,
            
            # Control structures
            "if_statement": self._handle_if_java,
            "for_statement": self._handle_for_java,
            "while_statement": self._handle_while_java,
            "try_statement": self._handle_try_java,
            
            # Exceptions
            "throw_statement": self._handle_throw_java,
            "catch_clause": self._handle_catch_java,
            
            # Advanced
            "lambda_expression": self._handle_lambda_java,
            "field_access": self._handle_field_java,
        }

    def _handle_method_java(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        params_node = node.child_by_field_name("parameters")
        param_count = 0
        parameters = []
        if params_node:
            for child in params_node.children:
                if child.type == "formal_parameter":
                    param_count += 1
                    param_name = ""
                    param_type = ""
                    type_node = child.child_by_field_name("type")
                    name_param = child.child_by_field_name("name")
                    if type_node:
                        param_type = self._get_text(type_node, source)
                    if name_param:
                        param_name = self._get_text(name_param, source)
                    parameters.append({"name": param_name, "type": param_type})
        
        # Extract return type
        return_type = ""
        type_node = node.child_by_field_name("type")
        if type_node:
            return_type = self._get_text(type_node, source)
        elif any(child.type == "void_type" for child in node.children):
            return_type = "void"
        
        # Extract annotations (may be direct children or inside a modifiers node)
        decorators = []
        for child in node.children:
            if child.type in ["marker_annotation", "annotation"]:
                decorators.append(self._get_text(child, source))
            elif child.type == "modifiers":
                for mod_child in child.children:
                    if mod_child.type in ["marker_annotation", "annotation"]:
                        decorators.append(self._get_text(mod_child, source))

        # Extract Javadoc
        docstring = self._get_preceding_comment(node, source)

        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": scope,
            "return_type": return_type,
            "decorators": decorators,
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_java(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        callee = self._get_text(name_node, source) if name_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
            arg_count = len(args_node.children) - 2
            if arg_count < 0: arg_count = 0

        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_java(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": len(node.children) > 2
        }, node.start_point[0] + 1)

    def _handle_import_java(self, node, source: str, scope: str) -> IRFact:
        # import java.util.List; or import static ...
        module_name = ""
        for child in node.children:
            if child.type == "scoped_identifier" or child.type == "identifier":
                module_name = self._get_text(child, source)
                break
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": [],
            "is_wildcard": "*" in module_name
        }, node.start_point[0] + 1)

    def _handle_class_java(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        base_classes = []
        superclass = node.child_by_field_name("superclass")
        if superclass:
            for child in superclass.children:
                if child.type == "type_identifier":
                    base_classes.append(self._get_text(child, source))
        
        # Extract annotations (may be direct children or inside a modifiers node)
        decorators = []
        for child in node.children:
            if child.type in ["marker_annotation", "annotation"]:
                decorators.append(self._get_text(child, source))
            elif child.type == "modifiers":
                for mod_child in child.children:
                    if mod_child.type in ["marker_annotation", "annotation"]:
                        decorators.append(self._get_text(mod_child, source))

        # Extract Javadoc
        docstring = self._get_preceding_comment(node, source)

        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": base_classes,
            "decorators": decorators,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_interface_java(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        # Count methods
        method_count = 0
        body = node.child_by_field_name("body")
        if body:
            method_count = sum(1 for child in body.children if child.type == "method_declaration")
        
        return IRFact("InterfaceDeclared", {
            "name": name,
            "base_interfaces": [],
            "method_count": method_count
        }, node.start_point[0] + 1)

    def _handle_enum_java(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        member_count = 0
        body = node.child_by_field_name("body")
        if body:
            member_count = sum(1 for child in body.children if child.type == "enum_constant")
        
        return IRFact("EnumDeclared", {
            "name": name,
            "member_count": member_count
        }, node.start_point[0] + 1)

    def _handle_if_java(self, node, source: str, scope: str) -> IRFact:
        has_else = node.child_by_field_name("alternative") is not None
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_for_java(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_while_java(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_try_java(self, node, source: str, scope: str) -> IRFact:
        has_else = node.child_by_field_name("finally") is not None
        return IRFact("ControlStructure", {
            "type": "TRY",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_throw_java(self, node, source: str, scope: str) -> IRFact:
        exception_type = "<unknown>"
        for child in node.children:
            if child.type == "object_creation_expression":
                type_node = child.child_by_field_name("type")
                if type_node:
                    exception_type = self._get_text(type_node, source)
                break
        
        return IRFact("ThrowStatement", {
            "exception_type": exception_type,
            "parent_function": scope,
            "has_message": True
        }, node.start_point[0] + 1)

    def _handle_catch_java(self, node, source: str, scope: str) -> IRFact:
        exception_types = []
        param = node.child_by_field_name("parameter")
        if param:
            type_node = param.child_by_field_name("type")
            if type_node:
                exception_types.append(self._get_text(type_node, source))
        
        return IRFact("CatchClause", {
            "exception_types": exception_types,
            "parent_function": scope,
            "is_catch_all": "Exception" in exception_types or not exception_types
        }, node.start_point[0] + 1)

    def _handle_lambda_java(self, node, source: str, scope: str) -> IRFact:
        params = node.child_by_field_name("parameters")
        param_count = 0
        if params:
            param_count = sum(1 for child in params.children if child.type == "identifier" or child.type == "formal_parameter")
        
        return IRFact("LambdaDeclared", {
            "param_count": param_count,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_field_java(self, node, source: str, scope: str) -> IRFact:
        object_name = ""
        member_name = ""
        
        obj_node = node.child_by_field_name("object")
        if obj_node:
            object_name = self._get_text(obj_node, source)
        
        field_node = node.child_by_field_name("field")
        if field_node:
            member_name = self._get_text(field_node, source)
        
        is_method_call = node.parent and node.parent.type == "method_invocation"
        
        return IRFact("MemberAccess", {
            "object_name": object_name,
            "member_name": member_name,
            "parent_function": scope,
            "is_method_call": is_method_call
        }, node.start_point[0] + 1)


    def _c_mapping(self):
        return {
            # Core
            "function_definition": self._handle_func_c,
            "call_expression": self._handle_call_c,
            "return_statement": self._handle_return_c,
            
            # Includes
            "preproc_include": self._handle_include_c,
            
            # Structs and Types
            "struct_specifier": self._handle_struct_c,
            "enum_specifier": self._handle_enum_c,
            
            # Control structures
            "if_statement": self._handle_if_c,
            "for_statement": self._handle_for_c,
            "while_statement": self._handle_while_c,
            "switch_statement": self._handle_switch_c,
            
            # Member access
            "field_expression": self._handle_field_c,
        }

    def _handle_func_c(self, node, source: str, scope: str) -> IRFact:
        declarator = node.child_by_field_name("declarator")
        name = "<anon>"
        param_count = 0
        parameters = []
        
        if declarator:
            func_decl = declarator
            while func_decl.type != "function_declarator" and func_decl.child_count > 0:
                 found = False
                 for child in func_decl.children:
                     if child.type == "function_declarator":
                         func_decl = child
                         found = True
                         break
                 if not found: break
            
            if func_decl.type == "function_declarator":
                declarator_node = func_decl.child_by_field_name("declarator")
                if declarator_node:
                    name = self._get_text(declarator_node, source)
                
                params = func_decl.child_by_field_name("parameters")
                if params:
                    for child in params.children:
                        if "parameter_declaration" in child.type:
                            param_count += 1
                            param_name = ""
                            param_type = ""
                            # C param: type + declarator
                            type_node = child.child_by_field_name("type")
                            decl_node = child.child_by_field_name("declarator")
                            if type_node:
                                param_type = self._get_text(type_node, source)
                            if decl_node:
                                param_name = self._get_text(decl_node, source)
                            else:
                                param_name = f"param{param_count}"
                            parameters.append({"name": param_name, "type": param_type})
        
        # Extract return type
        return_type = ""
        type_node = node.child_by_field_name("type")
        if type_node:
            return_type = self._get_text(type_node, source)
        
        # Extract comments
        docstring = self._get_preceding_comment(node, source)
        
        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": scope,
            "return_type": return_type,
            "decorators": [],  # C doesn't have decorators
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_c(self, node, source: str, scope: str) -> IRFact:
        func_node = node.child_by_field_name("function")
        callee = self._get_text(func_node, source) if func_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
            arg_count = len(args_node.children) - 2
            if arg_count < 0: arg_count = 0

        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_c(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": len(node.children) > 2
        }, node.start_point[0] + 1)

    def _handle_include_c(self, node, source: str, scope: str) -> IRFact:
        # #include <stdio.h> or #include "file.h"
        module_name = ""
        for child in node.children:
            if child.type == "string_literal" or child.type == "system_lib_string":
                module_name = self._get_text(child, source).strip('<>"')
                break
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": [],
            "is_wildcard": False
        }, node.start_point[0] + 1)

    def _handle_struct_c(self, node, source: str, scope: str) -> IRFact:
        name = "<anon>"
        name_node = node.child_by_field_name("name")
        if name_node:
            name = self._get_text(name_node, source)
        
        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": []
        }, node.start_point[0] + 1)

    def _handle_enum_c(self, node, source: str, scope: str) -> IRFact:
        name = "<anon>"
        name_node = node.child_by_field_name("name")
        if name_node:
            name = self._get_text(name_node, source)
        
        # Count enum members
        member_count = 0
        body = node.child_by_field_name("body")
        if body:
            member_count = sum(1 for child in body.children if child.type == "enumerator")
        
        return IRFact("EnumDeclared", {
            "name": name,
            "member_count": member_count
        }, node.start_point[0] + 1)

    def _handle_if_c(self, node, source: str, scope: str) -> IRFact:
        has_else = any(child.type == "else_clause" for child in node.children)
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_for_c(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_while_c(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_switch_c(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "SWITCH",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_field_c(self, node, source: str, scope: str) -> IRFact:
        object_name = ""
        member_name = ""
        
        arg_node = node.child_by_field_name("argument")
        if arg_node:
            object_name = self._get_text(arg_node, source)
        
        field_node = node.child_by_field_name("field")
        if field_node:
            member_name = self._get_text(field_node, source)
        
        is_method_call = node.parent and node.parent.type == "call_expression"
        
        return IRFact("MemberAccess", {
            "object_name": object_name,
            "member_name": member_name,
            "parent_function": scope,
            "is_method_call": is_method_call
        }, node.start_point[0] + 1)


    def _rust_mapping(self):
        return {
            # Core
            "function_item": self._handle_func_rust,
            "call_expression": self._handle_call_rust,
            "return_expression": self._handle_return_rust,
            
            # Imports
            "use_declaration": self._handle_use_rust,
            
            # Types
            "struct_item": self._handle_struct_rust,
            "trait_item": self._handle_trait_rust,
            "enum_item": self._handle_enum_rust,
            "impl_item": self._handle_impl_rust,
            
            # Control structures
            "if_expression": self._handle_if_rust,
            "loop_expression": self._handle_loop_rust,
            "for_expression": self._handle_for_rust,
            "while_expression": self._handle_while_rust,
            
            # Advanced
            "closure_expression": self._handle_closure_rust,
            "await_expression": self._handle_await_rust,
            "field_expression": self._handle_field_rust,
        }
    
    def _handle_func_rust(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        params_node = node.child_by_field_name("parameters")
        param_count = 0
        parameters = []
        if params_node:
            for child in params_node.children:
                if child.type == "parameter":
                    param_count += 1
                    param_name = ""
                    param_type = ""
                    # Rust param: pattern: type
                    pattern = child.child_by_field_name("pattern")
                    type_node = child.child_by_field_name("type")
                    if pattern:
                        param_name = self._get_text(pattern, source)
                    if type_node:
                        param_type = self._get_text(type_node, source)
                    parameters.append({"name": param_name, "type": param_type})
        
        # Extract return type
        return_type = ""
        return_type_node = node.child_by_field_name("return_type")
        if return_type_node:
            # Return type includes ->, skip it
            return_type = self._get_text(return_type_node, source).lstrip('->').strip()
        
        # Extract attributes (#[...])
        decorators = []
        for child in node.children:
            if child.type == "attribute_item":
                decorators.append(self._get_text(child, source))
        
        # Extract doc comments
        docstring = self._get_preceding_comment(node, source)

        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": scope,
            "return_type": return_type,
            "decorators": decorators,
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_rust(self, node, source: str, scope: str) -> IRFact:
        func_node = node.child_by_field_name("function")
        callee = self._get_text(func_node, source) if func_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
            arg_count = len(args_node.children) - 2
            if arg_count < 0: arg_count = 0

        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_rust(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": len(node.children) > 1
        }, node.start_point[0] + 1)

    def _handle_use_rust(self, node, source: str, scope: str) -> IRFact:
        # use std::collections::HashMap;
        module_name = ""
        for child in node.children:
            if child.type == "scoped_identifier" or child.type == "identifier":
                module_name = self._get_text(child, source)
                break
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": [],
            "is_wildcard": "*" in module_name
        }, node.start_point[0] + 1)

    def _handle_struct_rust(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": []
        }, node.start_point[0] + 1)

    def _handle_trait_rust(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        # Count methods
        method_count = 0
        body = node.child_by_field_name("body")
        if body:
            method_count = sum(1 for child in body.children if child.type == "function_item")
        
        return IRFact("InterfaceDeclared", {
            "name": name,
            "base_interfaces": [],
            "method_count": method_count
        }, node.start_point[0] + 1)

    def _handle_enum_rust(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        member_count = 0
        body = node.child_by_field_name("body")
        if body:
            member_count = sum(1 for child in body.children if child.type == "enum_variant")
        
        return IRFact("EnumDeclared", {
            "name": name,
            "member_count": member_count
        }, node.start_point[0] + 1)

    def _handle_impl_rust(self, node, source: str, scope: str) -> IRFact:
        # impl MyStruct { ... } - treat as class-like
        type_node = node.child_by_field_name("type")
        name = self._get_text(type_node, source) if type_node else "<anon>"
        
        return IRFact("ClassDeclared", {
            "name": f"impl {name}",
            "base_classes": []
        }, node.start_point[0] + 1)

    def _handle_if_rust(self, node, source: str, scope: str) -> IRFact:
        has_else = node.child_by_field_name("alternative") is not None
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_loop_rust(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",  # loop is like infinite while
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_for_rust(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_while_rust(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_closure_rust(self, node, source: str, scope: str) -> IRFact:
        # |x| x + 1
        params = node.child_by_field_name("parameters")
        param_count = 0
        if params:
            param_count = sum(1 for child in params.children if child.type == "identifier" or child.type == "parameter")
        
        return IRFact("LambdaDeclared", {
            "param_count": param_count,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_await_rust(self, node, source: str, scope: str) -> IRFact:
        # expr.await
        awaited_function = "<unknown>"
        for child in node.children:
            if child.type != "await":
                awaited_function = self._get_text(child, source)
                break
        
        return IRFact("AwaitExpression", {
            "awaited_function": awaited_function,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_field_rust(self, node, source: str, scope: str) -> IRFact:
        # obj.field
        object_name = ""
        member_name = ""
        
        value = node.child_by_field_name("value")
        if value:
            object_name = self._get_text(value, source)
        
        field = node.child_by_field_name("field")
        if field:
            member_name = self._get_text(field, source)
        
        is_method_call = node.parent and node.parent.type == "call_expression"
        
        return IRFact("MemberAccess", {
            "object_name": object_name,
            "member_name": member_name,
            "parent_function": scope,
            "is_method_call": is_method_call
        }, node.start_point[0] + 1)


    def _ruby_mapping(self):
        return {
            # Core
            "method": self._handle_method_ruby,
            "singleton_method": self._handle_method_ruby,
            "call": self._handle_call_or_require_ruby,  # require is also a call
            "return": self._handle_return_ruby,

            # Classes and Modules
            "class": self._handle_class_ruby,
            "module": self._handle_module_ruby,
            
            # Control structures
            "if": self._handle_if_ruby,
            "unless": self._handle_unless_ruby,
            "while": self._handle_while_ruby,
            "for": self._handle_for_ruby,
            
            # Exceptions
            "raise": self._handle_raise_ruby,
            "rescue_clause": self._handle_rescue_ruby,
            
            # Advanced
            "block": self._handle_block_ruby,
            "lambda": self._handle_lambda_ruby,
        }

    def _handle_method_ruby(self, node, source: str, scope: str) -> IRFact:
        # In tree-sitter-ruby, method name is usually an identifier child
        name_node = node.child_by_field_name("name")
        if not name_node:
            for child in node.children:
                if child.type == "identifier":
                    name_node = child
                    break
        
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        params_node = node.child_by_field_name("parameters")
        param_count = 0
        parameters = []
        if params_node:
            for child in params_node.children:
                if child.type == "identifier":
                    param_count += 1
                    parameters.append({"name": self._get_text(child, source), "type": ""})
        
        # Extract doc comments
        docstring = self._get_preceding_comment(node, source)

        return IRFact("FunctionDeclared", {
            "name": name,
            "param_count": param_count,
            "parent_scope": scope,
            "return_type": "",  # Ruby doesn't have type annotations by default
            "decorators": [],  # Ruby doesn't have decorators
            "parameters": parameters,
            "docstring": docstring,
        }, node.start_point[0] + 1)

    def _handle_call_ruby(self, node, source: str, scope: str) -> IRFact:
        method_node = node.child_by_field_name("method")
        if not method_node:
            for child in node.children:
                if child.type == "identifier":
                    method_node = child
                    break
        
        callee = self._get_text(method_node, source) if method_node else "<unknown>"
        
        args_node = node.child_by_field_name("arguments")
        arg_count = 0
        if args_node:
             arg_count = sum(1 for child in args_node.children if child.type not in ["(", ")", ","])

        return IRFact("FunctionCall", {
            "caller_function": scope,
            "callee_name": callee,
            "arg_count": arg_count
        }, node.start_point[0] + 1)

    def _handle_return_ruby(self, node, source: str, scope: str) -> IRFact:
        has_value = False
        args = node.child_by_field_name("arguments")
        if args:
            has_value = True
        elif len(node.children) > 1:
             has_value = True
             
        return IRFact("ReturnStatement", {
            "function_name": scope,
            "has_value": has_value
        }, node.start_point[0] + 1)

    def _handle_call_or_require_ruby(self, node, source: str, scope: str) -> IRFact:
        # require/require_relative become imports; everything else is a regular call
        return self._handle_require_ruby(node, source, scope) or self._handle_call_ruby(node, source, scope)

    def _handle_require_ruby(self, node, source: str, scope: str) -> IRFact:
        # Check if this is a require/require_relative call
        method_node = node.child_by_field_name("method")
        if not method_node:
            for child in node.children:
                if child.type == "identifier":
                    method_node = child
                    break
        
        method_name = self._get_text(method_node, source) if method_node else ""
        
        if method_name not in ["require", "require_relative"]:
            return None  # Not a require, handle as regular call
        
        # Extract module name
        module_name = ""
        args_node = node.child_by_field_name("arguments")
        if args_node:
            for child in args_node.children:
                if child.type == "string":
                    module_name = self._get_text(child, source).strip("'\"")
                    break
        
        return IRFact("ImportStatement", {
            "module_name": module_name,
            "imported_names": [],
            "is_wildcard": False
        }, node.start_point[0] + 1)

    def _handle_class_ruby(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        base_classes = []
        superclass = node.child_by_field_name("superclass")
        if superclass:
            base_classes.append(self._get_text(superclass, source))
        
        return IRFact("ClassDeclared", {
            "name": name,
            "base_classes": base_classes
        }, node.start_point[0] + 1)

    def _handle_module_ruby(self, node, source: str, scope: str) -> IRFact:
        name_node = node.child_by_field_name("name")
        name = self._get_text(name_node, source) if name_node else "<anon>"
        
        return IRFact("ClassDeclared", {
            "name": f"module {name}",
            "base_classes": []
        }, node.start_point[0] + 1)

    def _handle_if_ruby(self, node, source: str, scope: str) -> IRFact:
        has_else = any(child.type in ["else", "elsif"] for child in node.children)
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_unless_ruby(self, node, source: str, scope: str) -> IRFact:
        # unless is like "if not"
        has_else = any(child.type == "else" for child in node.children)
        return IRFact("ControlStructure", {
            "type": "IF",
            "parent_function": scope,
            "has_else": has_else
        }, node.start_point[0] + 1)

    def _handle_while_ruby(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "WHILE",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_for_ruby(self, node, source: str, scope: str) -> IRFact:
        return IRFact("ControlStructure", {
            "type": "FOR",
            "parent_function": scope,
            "has_else": False
        }, node.start_point[0] + 1)

    def _handle_raise_ruby(self, node, source: str, scope: str) -> IRFact:
        exception_type = "<unknown>"
        for child in node.children:
            if child.type == "identifier" or child.type == "constant":
                exception_type = self._get_text(child, source)
                break
        
        return IRFact("ThrowStatement", {
            "exception_type": exception_type,
            "parent_function": scope,
            "has_message": len(node.children) > 2
        }, node.start_point[0] + 1)

    def _handle_rescue_ruby(self, node, source: str, scope: str) -> IRFact:
        exception_types = []
        for child in node.children:
            if child.type == "exceptions":
                for exc in child.children:
                    if exc.type == "constant":
                        exception_types.append(self._get_text(exc, source))
        
        return IRFact("CatchClause", {
            "exception_types": exception_types,
            "parent_function": scope,
            "is_catch_all": not exception_types
        }, node.start_point[0] + 1)

    def _handle_block_ruby(self, node, source: str, scope: str) -> IRFact:
        # { |x| ... } or do |x| ... end
        params = node.child_by_field_name("parameters")
        param_count = 0
        if params:
            param_count = sum(1 for child in params.children if child.type == "identifier")
        
        return IRFact("LambdaDeclared", {
            "param_count": param_count,
            "parent_function": scope
        }, node.start_point[0] + 1)

    def _handle_lambda_ruby(self, node, source: str, scope: str) -> IRFact:
        # -> (x) { ... } or lambda { |x| ... }
        param_count = 0
        for child in node.children:
            if child.type == "parameters" or child.type == "block_parameters":
                param_count = sum(1 for c in child.children if c.type == "identifier")
                break
        
        return IRFact("LambdaDeclared", {
            "param_count": param_count,
            "parent_function": scope
        }, node.start_point[0] + 1)

