package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/reclaimprotocol/reclaim-tee/providers"
	"github.com/reclaimprotocol/reclaim-tee/shared"
)

const reclaimValidateMaxRequestBytes = 50 * 1024 * 1024

type reclaimValidateExtractionRequest struct {
	ResponseBody  string `json:"responseBody"`
	ExpectedValue string `json:"expectedValue"`
	XPath         string `json:"xPath,omitempty"`
	JSONPath      string `json:"jsonPath,omitempty"`
	Regex         string `json:"regex,omitempty"`
}

type reclaimValidateExtractionResponse struct {
	Valid           bool                            `json:"valid"`
	ExtractedValue  *string                         `json:"extractedValue"`
	XPathResult     *string                         `json:"xpathResult"`
	JSONPathResult  *string                         `json:"jsonPathResult"`
	RegexResult     *string                         `json:"regexResult"`
	TEEValid        bool                            `json:"teeValid"`
	RedactionRanges []shared.ResponseRedactionRange `json:"redactionRanges,omitempty"`
	Error           *string                         `json:"error"`
	Steps           []string                        `json:"steps"`
}

func reclaimValidateExtractionHTTPHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "POST, OPTIONS")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		writeReclaimValidationJSON(w, http.StatusMethodNotAllowed, reclaimValidateExtractionResponse{
			Valid: false,
			Error: stringPtr("method not allowed"),
		})
		return
	}

	defer r.Body.Close()
	var req reclaimValidateExtractionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, reclaimValidateMaxRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeReclaimValidationJSON(w, http.StatusBadRequest, reclaimValidateExtractionResponse{
			Valid: false,
			Error: stringPtr(fmt.Sprintf("invalid request body: %v", err)),
		})
		return
	}

	writeReclaimValidationJSON(w, http.StatusOK, validateExtractionWithTEE(req))
}

func validateExtractionWithTEE(req reclaimValidateExtractionRequest) reclaimValidateExtractionResponse {
	steps := []string{"Validating extraction with reclaim-tee providers.GetResponseRedactions"}

	if req.XPath == "" && req.JSONPath == "" && req.Regex == "" {
		return reclaimValidateExtractionResponse{
			Valid: false,
			Error: stringPtr("Expected either xPath, jsonPath or regex for redaction"),
			Steps: steps,
		}
	}

	header := fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", len([]byte(req.ResponseBody)))
	fullHTTPResponse := []byte(header + req.ResponseBody)
	params := providers.HTTPProviderParams{
		URL:    "https://reclaim-validator.local/",
		Method: "GET",
		ResponseMatches: []providers.ResponseMatch{
			{Value: req.ExpectedValue, Type: "contains"},
		},
		ResponseRedactions: []providers.ResponseRedaction{
			{
				XPath:    req.XPath,
				JSONPath: req.JSONPath,
				Regex:    req.Regex,
			},
		},
	}
	ctx := &providers.ProviderCtx{Version: providers.ATTESTOR_VERSION_3_0_0}
	redactions, err := providers.GetResponseRedactions(fullHTTPResponse, &params, ctx, "validate-extraction")
	if err != nil {
		steps = append(steps, fmt.Sprintf("TEE validation failed: %v", err))
		return reclaimValidateExtractionResponse{
			Valid: false,
			Error: stringPtr(fmt.Sprintf("TEE validation failed: %v", err)),
			Steps: steps,
		}
	}
	steps = append(steps, fmt.Sprintf("TEE validation succeeded with %d redaction ranges", len(redactions)))

	extracted, xpathResult, jsonPathResult, regexResult, extractSteps, err := extractValidatedValue(req)
	steps = append(steps, extractSteps...)
	if err != nil {
		return reclaimValidateExtractionResponse{
			Valid:           false,
			TEEValid:        true,
			RedactionRanges: redactions,
			Error:           stringPtr(fmt.Sprintf("failed to derive extracted value after TEE validation: %v", err)),
			Steps:           steps,
		}
	}

	extracted = strings.TrimSpace(extracted)
	valid := extracted == req.ExpectedValue
	steps = append(
		steps,
		fmt.Sprintf("Final extracted value: %q", extracted),
		fmt.Sprintf("Expected value: %q", req.ExpectedValue),
		fmt.Sprintf("Match: %t", valid),
	)

	var errPtr *string
	if !valid {
		errPtr = stringPtr(fmt.Sprintf("Expected %q but got %q", req.ExpectedValue, extracted))
	}

	return reclaimValidateExtractionResponse{
		Valid:           valid,
		ExtractedValue:  stringPtr(extracted),
		XPathResult:     xpathResult,
		JSONPathResult:  jsonPathResult,
		RegexResult:     regexResult,
		TEEValid:        true,
		RedactionRanges: redactions,
		Error:           errPtr,
		Steps:           steps,
	}
}

func extractValidatedValue(req reclaimValidateExtractionRequest) (string, *string, *string, *string, []string, error) {
	steps := []string{}
	element := req.ResponseBody
	var xpathResult *string
	var jsonPathResult *string
	var regexResult *string

	if req.XPath != "" {
		contentsOnly := req.JSONPath != ""
		steps = append(steps, fmt.Sprintf("Evaluating XPath with TEE contentsOnly=%t", contentsOnly))
		ranges, err := providers.ExtractHTMLElementsIndexes(element, req.XPath, contentsOnly)
		if err != nil {
			return "", nil, nil, nil, steps, err
		}
		if len(ranges) == 0 {
			return "", nil, nil, nil, steps, fmt.Errorf("XPath %q did not match any element", req.XPath)
		}
		element = element[ranges[0].Start:ranges[0].End]
		xpathResult = stringPtr(element)
		steps = append(steps, previewStep("XPath extraction successful", element))
	}

	if req.JSONPath != "" {
		steps = append(steps, fmt.Sprintf("Evaluating JSONPath: %s", req.JSONPath))
		ranges, err := providers.ExtractJSONValueIndexes([]byte(element), req.JSONPath)
		if err != nil {
			return "", xpathResult, nil, nil, steps, err
		}
		if len(ranges) == 0 {
			return "", xpathResult, nil, nil, steps, fmt.Errorf("JSONPath %q did not match any value", req.JSONPath)
		}
		element = element[ranges[0].Start:ranges[0].End]
		jsonPathResult = stringPtr(element)
		steps = append(steps, previewStep("JSONPath extraction successful", element))
	}

	if req.Regex != "" {
		steps = append(steps, fmt.Sprintf("Applying TEE regex: %s", req.Regex))
		value, err := extractWithTEERegex(element, req.Regex)
		if err != nil {
			return "", xpathResult, jsonPathResult, nil, steps, err
		}
		element = value
		regexResult = stringPtr(value)
		steps = append(steps, previewStep("Regex extraction successful", value))
	} else if req.JSONPath != "" {
		element = normalizeJSONValue(element)
	}

	return element, xpathResult, jsonPathResult, regexResult, steps, nil
}

var jsNamedGroupPattern = regexp.MustCompile(`\(\?<([A-Za-z][A-Za-z0-9_]*)>`)

func makeTEERegex(pattern string) (*regexp.Regexp, error) {
	converted := jsNamedGroupPattern.ReplaceAllString(pattern, `(?P<$1>`)
	return regexp.Compile("(?si)" + converted)
}

func extractWithTEERegex(element string, pattern string) (string, error) {
	re, err := makeTEERegex(pattern)
	if err != nil {
		return "", fmt.Errorf("invalid regexp %q: %w", pattern, err)
	}

	matches := re.FindStringSubmatchIndex(element)
	if matches == nil {
		return "", fmt.Errorf("regexp %s does not match found element", pattern)
	}

	names := re.SubexpNames()
	for i, name := range names {
		if i == 0 || name == "" {
			continue
		}
		from := matches[2*i]
		to := matches[2*i+1]
		if from >= 0 && to >= 0 {
			return element[from:to], nil
		}
	}

	return element[matches[0]:matches[1]], nil
}

func normalizeJSONValue(value string) string {
	trimmed := strings.TrimSpace(value)
	var decoded any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return trimmed
	}
	if str, ok := decoded.(string); ok {
		return str
	}
	normalized, err := json.Marshal(decoded)
	if err != nil {
		return trimmed
	}
	return string(normalized)
}

func previewStep(label string, value string) string {
	const maxPreviewLen = 100
	preview := value
	if len(preview) > maxPreviewLen {
		preview = preview[:maxPreviewLen] + "..."
	}
	return fmt.Sprintf("%s: %q", label, preview)
}

func writeReclaimValidationJSON(w http.ResponseWriter, status int, payload reclaimValidateExtractionResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func stringPtr(value string) *string {
	return &value
}
